// Builds the zip the Chrome Web Store wants.
//
// The store takes a ZIP whose root is `manifest.json` — never a CRX; Google
// signs the upload and produces the CRX itself. So this stages exactly what
// ships into `dist/unpacked/` and zips that directory's contents.
//
// # Why a staging directory rather than zipping the repo
//
// The extension root IS the repo root, and the repo root is ~300 MB:
// `wasm/target` alone is 285 MB of Rust build artifacts and `node_modules`
// another 18. The payload is about 1.2 MB. Zipping in place would ship the lot
// — including a `target/` full of intermediate objects — which is slow, leaks
// build-machine paths, and is the kind of thing a store reviewer notices.
//
// # Why it verifies afterwards
//
// `src/vendor/` is gitignored: it is wasm-pack output, reproduced from the
// revision pinned in `wasm/Cargo.toml`. That makes it exactly the thing a fresh
// clone forgets to build and a zip silently ships without. An extension missing
// its wasm module installs fine and fails at the moment a user tries to sign,
// so the check is here rather than left to discovery.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'unpacked');

function die(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

/** Paths use `/` here regardless of platform, so the skip rules read plainly. */
const posix = (path) => path.split(sep).join('/');

// --- what ships -------------------------------------------------------------

/** Copied wholesale, minus the skips below. */
const INCLUDE = ['manifest.json', 'src', 'icons'];

/**
 * Excluded from the copy.
 *
 * The `.d.ts` files are ~90 KB of wasm-pack TypeScript declarations that no
 * runtime ever loads — they exist for editors. The vendor `package.json` is
 * wasm-pack's own metadata and is likewise never read by the extension.
 */
const SKIP = [
  (p) => p.endsWith('/.DS_Store') || p === '.DS_Store',
  (p) => p.endsWith('/.gitignore'),
  (p) => p.endsWith('.d.ts'),
  (p) => p === 'src/vendor/verus-wasm/package.json',
];

/**
 * Files nothing in the manifest points at, so nothing else would catch them.
 *
 * The wasm module is reached by an `import` inside `approve.js` and `popup.js`;
 * from the manifest's point of view it does not exist.
 */
const REQUIRED = ['src/vendor/verus-wasm/verus_wasm.js', 'src/vendor/verus-wasm/verus_wasm_bg.wasm'];

// --- read the manifest ------------------------------------------------------

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
} catch (error) {
  die(`manifest.json is unreadable: ${error.message}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// A mismatch here ships a zip whose version is not the one that was tested, and
// the store rejects a re-upload of a version it already has — so the failure
// arrives late and confusingly. Cheaper to refuse now.
if (manifest.version !== pkg.version) {
  die(
    `version mismatch: manifest.json is ${manifest.version}, package.json is ${pkg.version}.\n` +
      '    Bump both, then run again.',
  );
}

if (!manifest.icons || Object.keys(manifest.icons).length === 0) {
  die('manifest.json declares no icons. Run `npm run icons`, or add real artwork.');
}

// --- stage ------------------------------------------------------------------

rmSync(DIST, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) {
    die(
      entry === 'icons'
        ? 'icons/ is missing. Run `npm run icons` first.'
        : `${entry} is missing from the extension root.`,
    );
  }
  cpSync(from, join(STAGE, entry), {
    recursive: true,
    filter: (source) => {
      const rel = posix(relative(ROOT, source));
      return !SKIP.some((skip) => skip(rel));
    },
  });
}

// --- verify -----------------------------------------------------------------

/** Every path the manifest promises Chrome it will find. */
function declaredPaths(m) {
  const paths = [];
  if (m.background?.service_worker) paths.push(m.background.service_worker);
  if (m.action?.default_popup) paths.push(m.action.default_popup);
  for (const script of m.content_scripts ?? []) {
    paths.push(...(script.js ?? []), ...(script.css ?? []));
  }
  for (const resource of m.web_accessible_resources ?? []) {
    // Globs are legal here; only literal paths can be checked.
    paths.push(...(resource.resources ?? []).filter((r) => !r.includes('*')));
  }
  paths.push(...Object.values(m.icons ?? {}));
  return [...new Set(paths)];
}

const missing = [...declaredPaths(manifest), ...REQUIRED].filter(
  (path) => !existsSync(join(STAGE, path)),
);

if (missing.length) {
  const wasmMissing = missing.some((p) => p.startsWith('src/vendor/'));
  die(
    `the staged extension is missing ${missing.length} file(s):\n` +
      missing.map((p) => `      ${p}`).join('\n') +
      (wasmMissing ? '\n\n    The wasm module is not committed — run `npm run build:wasm` first.' : ''),
  );
}

// --- report and zip ---------------------------------------------------------

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

const staged = walk(STAGE);
const bytes = staged.reduce((total, path) => total + statSync(path).size, 0);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

const zipName = `${pkg.name}-${manifest.version}.zip`;
const zipPath = join(DIST, zipName);

try {
  // `-X` drops the macOS extended attributes and resource forks that otherwise
  // ride along as `__MACOSX` entries and make a reviewer wonder what they are.
  // Run from inside the staging directory so `manifest.json` sits at the zip
  // root, which is the one thing the store is strict about.
  execFileSync('zip', ['-r', '-X', '-9', '-q', zipPath, '.'], { cwd: STAGE });
} catch (error) {
  if (error.code === 'ENOENT') {
    die(
      'the `zip` command was not found.\n' +
        `    The staged extension is ready at dist/unpacked — zip its CONTENTS by hand\n` +
        '    (manifest.json must be at the zip root, not inside a folder).',
    );
  }
  die(`zip failed: ${error.message}`);
}

const zipped = statSync(zipPath).size;

console.log(`
  ${manifest.name} ${manifest.version}

  ${staged.length} files, ${kb(bytes)} unpacked → ${kb(zipped)} zipped
  dist/${zipName}

  Load dist/unpacked in chrome://extensions to check it before uploading,
  then upload the zip at https://chrome.google.com/webstore/devconsole
`);
