# uqr, vendored

The QR encoder behind the address on the Receive screen.

    package   uqr@0.1.3            https://www.npmjs.com/package/uqr
    file      dist/index.mjs  →  uqr.mjs, byte for byte
    sha256    7f0e61c2f13bb3724edee7bfb876e13c54ac9ee4fcfa283c9fa93cfb1241c325
    licence   MIT — Project Nayuki, and Anthony Fu. See LICENSE.

## Why a copy and not a dependency

The extension loads ES modules straight from `src/` with no bundler, so anything
it imports at runtime has to exist in the shipped tree. Vendoring it makes the
exact bytes that reach a user reviewable in this repository and in the store
upload, which a `node_modules` entry resolved at build time would not be.

Kept unmodified on purpose: the checksum above is the whole point, and it is
only worth something while the file still matches what npm publishes.

    npm pack uqr@0.1.3 && tar xzf uqr-0.1.3.tgz
    shasum -a 256 package/dist/index.mjs

## Why this one

It is a port of Project Nayuki's reference QR generator — the implementation
most other libraries are themselves derived from — with no dependencies, in one
self-contained ES module.

A QR code that is subtly wrong does not look wrong: it scans cleanly, to the
wrong address. That is why this was left out of the wallet until there was a
vetted encoder to do it with, and why `tests/extension.test.mjs` decodes the
rendered pixels with an independent decoder and compares the result to the
address, rather than trusting either the library or the drawing code.
