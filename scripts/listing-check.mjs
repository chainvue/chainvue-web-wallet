// Checks the store copy against the dashboard's field limits.
//
// The submission form truncates silently in some fields and refuses in others,
// and either way you find out while looking at a half-filled form rather than
// while editing prose. This reads `store/listing.md`, finds every heading that
// declares a limit — `### Summary — 132 max` — and measures the fenced block
// under it.
//
//   npm run listing:check
//
// Counting is by UTF-16 code unit, which is what a browser textarea's
// maxlength counts. The copy uses em dashes and typographic quotes; those are
// one unit each, but an emoji would be two, so do not assume characters.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTING = join(ROOT, 'store', 'listing.md');

let markdown;
try {
  markdown = readFileSync(LISTING, 'utf8');
} catch {
  console.error('\n  ✗ store/listing.md not found\n');
  process.exit(1);
}

/** `### Item name — 75 max`, followed anywhere below by a fenced block. */
const HEADING = /^###\s+(.+?)\s+—\s+([\d,]+)\s+max\s*$/gm;

const fields = [];
for (const match of markdown.matchAll(HEADING)) {
  const [, name, rawLimit] = match;
  const rest = markdown.slice(match.index + match[0].length);
  const fence = rest.match(/```[^\n]*\n([\s\S]*?)```/);
  if (!fence) {
    fields.push({ name, limit: Number(rawLimit.replace(/,/g, '')), length: null });
    continue;
  }
  fields.push({
    name,
    limit: Number(rawLimit.replace(/,/g, '')),
    // Trailing newline before the closing fence is markdown's, not the copy's.
    length: fence[1].replace(/\n$/, '').length,
  });
}

if (fields.length === 0) {
  console.error('\n  ✗ no limit-bearing headings found in store/listing.md\n');
  process.exit(1);
}

let failed = 0;
console.log();
for (const { name, limit, length } of fields) {
  if (length === null) {
    console.log(`  ✗ ${name.padEnd(22)} no fenced block under the heading`);
    failed += 1;
    continue;
  }
  const over = length > limit;
  if (over) failed += 1;
  const room = limit - length;
  console.log(
    `  ${over ? '✗' : '✓'} ${name.padEnd(22)} ${String(length).padStart(6)} / ${limit}` +
      (over ? `  OVER BY ${-room}` : `  (${room} to spare)`),
  );
}
console.log();

process.exit(failed ? 1 : 0);
