// Bump the version in the two places that must agree.
//
//   npm run bump 0.1.1
//
// `manifest.json` is what the browser and the Chrome Web Store read;
// `package.json` is what names the zip. `scripts/package.mjs` refuses to build
// when they disagree, which is the right failure — but it arrives at packaging
// time, after the commit. Changing both from one command means they cannot
// drift in the first place.
//
// Chrome's version format is its own: one to four dot-separated integers,
// each 0–65535, no leading zeros, and no suffixes — `1.0.0-beta` is refused at
// upload with a message that does not mention the format.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

function die(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

if (!next) die('usage: npm run bump 0.1.1');

const CHROME_VERSION = /^\d{1,5}(\.\d{1,5}){0,3}$/;
if (!CHROME_VERSION.test(next) || /(^|\.)0\d/.test(next)) {
  die(`"${next}" is not a Chrome extension version — one to four numbers, 0–65535 each, no leading zeros, no suffix`);
}
if (next.split('.').some((part) => Number(part) > 65_535)) {
  die(`"${next}" has a part above 65535, which Chrome refuses`);
}

const files = ['manifest.json', 'package.json'];
const before = [];

for (const name of files) {
  const path = join(ROOT, name);
  const text = readFileSync(path, 'utf8');
  const current = JSON.parse(text).version;
  before.push(current);

  // Edited as text, not re-serialised: rewriting the JSON would reformat files
  // that are read by people and reviewed in diffs.
  const replaced = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  if (replaced === text) die(`could not find a version field in ${name}`);
  writeFileSync(path, replaced);
}

if (before[0] !== before[1]) {
  console.warn(`\n  ! they had drifted: manifest.json was ${before[0]}, package.json was ${before[1]}`);
}

console.log(`
  ${before[0]} → ${next}   manifest.json, package.json

  Next:
    git commit -am "release: ${next}"
    git tag v${next}
    git push && git push --tags
`);
