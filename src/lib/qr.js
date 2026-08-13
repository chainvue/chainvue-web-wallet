// The address as something a phone can read.
//
// # Why this took until now
//
// A QR code that is subtly wrong does not look wrong. It scans, cleanly, to an
// address nobody holds the key for — so the failure mode of a hand-rolled
// encoder is silent, arrives at the moment somebody is being paid, and is
// unrecoverable. That is why the Receive screen shipped without one and said so.
//
// What changed is not the risk but the evidence: the encoder is Project
// Nayuki's, vendored unmodified (see `src/vendor/qr/README.md`), and the test
// suite decodes the pixels this file actually draws with an independent decoder
// and compares the result to the address. Neither the library nor the drawing
// code is taken on trust.

import { encode } from '../vendor/qr/uqr.mjs';

/**
 * Dark on light, and not the other way round.
 *
 * Everything else in this wallet is green on black, and an inverted QR is
 * refused by a good many scanners — the standard fixes the polarity, and the
 * finder patterns are located by looking for dark on light. So the code sits on
 * its own white card. It reads as deliberate rather than as a stray element,
 * and it is the version that works.
 */
const DARK = '#000000';
const LIGHT = '#ffffff';

/**
 * The quiet zone, in modules, and part of the code rather than styling around
 * it. The standard asks for four; drawing them into the canvas means the margin
 * survives a screenshot, a crop, or a stylesheet that never loads.
 */
const BORDER = 4;

/**
 * Draw `text` and hand back the canvas.
 *
 * Sized by whole modules, never by scaling afterwards: a QR resampled to a
 * fractional module width blurs the module edges, which is exactly the detail a
 * decoder is looking for. The canvas is therefore whatever multiple of the
 * module count lands nearest `width`, and CSS is not allowed to stretch it.
 */
export function qrCanvas(text, { width = 176 } = {}) {
  const value = String(text ?? '');
  if (!value) throw new Error('nothing to encode');

  // 'M' recovers 15% and is what wallets conventionally use for an address: it
  // survives a fingerprint on a screen without pushing the code up a version
  // and shrinking the modules, which would cost more legibility than it buys.
  const qr = encode(value, { ecc: 'M', border: BORDER });

  const scale = Math.max(2, Math.round(width / qr.size));
  const side = qr.size * scale;

  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  canvas.style.width = `${side}px`;
  canvas.style.height = `${side}px`;
  // The address is the alt text: a screen reader reads the value out rather
  // than announcing that there is a picture of it.
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `QR code for ${value}`);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = LIGHT;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = DARK;
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      // `data[y][x]` is true for a dark module. Rows first — the library's
      // matrix is indexed the same way, and transposing it produces a code that
      // still scans, to something else.
      if (qr.data[y][x]) ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }

  return canvas;
}
