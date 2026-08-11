// Generates the extension's icons, in the palette everything else wears.
//
// Placeholders, but not throwaway ones: the mark is the `▚` from the popup's
// own heading — upper-left and lower-right quadrants inside a phosphor frame —
// drawn as rectangles rather than set in a font, so it stays crisp at 16px
// where a rasterised glyph turns to mush.
//
// A hand-drawn PNG encoder rather than a dependency: this writes four small
// opaque RGB images, which is IHDR + one deflated IDAT + IEND and nothing else.
// Adding an image library to the build of a wallet to draw two squares is not
// a trade worth making.
//
//   npm run icons
//
// Replace these with real artwork before a public listing; the store judges a
// wallet partly on whether it looks like one.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

// style.css, verbatim: --bg, --frame, --accent.
const BG = [0x00, 0x06, 0x00];
const FRAME = [0x00, 0x87, 0x00];
const GLYPH = [0x5f, 0xff, 0x87];

/** 16 toolbar, 32 Windows, 48 management page, 128 store listing and install. */
const SIZES = [16, 32, 48, 128];

// --- the mark ---------------------------------------------------------------

/**
 * Every dimension is forced even so the two quadrants are the same size.
 *
 * At 16px a single pixel of asymmetry is visible as a wobble, and the toolbar
 * icon is the one users actually look at.
 */
function render(size) {
  const px = new Uint8Array(size * size * 3);

  const set = (x, y, colour) => {
    const i = (y * size + x) * 3;
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
  };
  const fill = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, colour);
  };

  fill(0, 0, size, size, BG);

  const margin = Math.max(1, Math.round(size / 8));
  const box = (size - margin * 2) & ~1; // even
  const stroke = Math.max(1, Math.round(size / 32));
  const origin = Math.floor((size - box) / 2);

  // The frame, as four bars rather than an outlined rect.
  fill(origin, origin, box, stroke, FRAME);
  fill(origin, origin + box - stroke, box, stroke, FRAME);
  fill(origin, origin, stroke, box, FRAME);
  fill(origin + box - stroke, origin, stroke, box, FRAME);

  // The glyph, inset by the frame and the same gap again.
  const inset = stroke * 2;
  const inner = (box - inset * 2) & ~1;
  const half = inner / 2;
  const ix = origin + inset;
  const iy = origin + inset;

  fill(ix, iy, half, half, GLYPH); // upper left
  fill(ix + half, iy + half, half, half, GLYPH); // lower right

  return px;
}

// --- PNG --------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Colour type 2 (RGB), 8 bits, filter 0 on every scanline. No alpha, no tricks. */
function encode(size, px) {
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(px.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- go ---------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT, `icon-${size}.png`);
  const bytes = encode(size, render(size));
  writeFileSync(file, bytes);
  console.log(`icons/icon-${size}.png  ${bytes.length} bytes`);
}
