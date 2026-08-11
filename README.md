# verus-launchpad-wallet

A non-custodial Verus wallet as a Chrome extension. Keys are encrypted in the
browser, transactions are built and signed in WebAssembly, and every one is
shown *built* — txid, fee, what it burns — before anything is broadcast.

The companion to [`verus-launchpad-web`](../verus-launchpad-web), but not
coupled to it: the two meet only at `window.verus`, and either works with any
counterpart that speaks it.

## The split

```
page                    extension
────                    ─────────
window.verus.request()
   │
   ├─ content.js  ── bridge, isolated world; stamps the real origin
   │     │
   │     └─ background.js ── routes. no keys, no wasm, signs nothing
   │            │
   │            └─ approve.html ── the only place a key is decrypted
   │                   │            and the only place wasm loads
   │                   ├─ vault.open()      PBKDF2 600k → AES-GCM
   │                   ├─ Key.fromWif()     verus-wasm
   │                   ├─ planLaunch(…)     build + sign, no network in wasm
   │                   └─ sendrawtransaction
   ▼
 txid
```

The decrypted key exists for the lifetime of one approval window and is freed
in a `finally`. The service worker never sees it. The page never sees it. There
is no method that returns it.

## Signing is the SDK's, not ours

`wasm/src/lib.rs` is one line — `pub use verus_wasm::*`. Every byte this wallet
signs comes from the Verus Rust SDK, pinned by revision to **the same commit
`pecu` uses**. A wallet that signed differently from the CLI would be a second
implementation of consensus-critical serialisation, which is the thing worth
never having twice.

## Two-stage approval

Most wallets show you what a page *claims* it wants, then sign it. This one
does that, and then shows you what it actually *built*:

1. **the request** — origin, action, the page's own description. Take the
   passphrase. Build.
2. **the transaction** — the real txid, the real fee, the currency id a launch
   will create, the block it starts at. Nothing has left the machine yet.
   Broadcast, or discard.

Stage 2 exists because a request is a claim and a built transaction is a fact.

## Build and install

The wasm module is not committed; build it first.

```sh
npm install
npm run build:wasm      # ~20s, needs rustup + wasm-pack + wasm32-unknown-unknown
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked**
→ pick this directory.

## Packaging for the Chrome Web Store

```sh
npm run package        # build:wasm, stage, verify, zip
```

Leaves `dist/unpacked/` — load that in `chrome://extensions` to check the real
thing — and `dist/verus-launchpad-wallet-<version>.zip`, which is what gets
uploaded. The store takes a **zip**, never a CRX: Google signs the upload and
produces the CRX itself. `manifest.json` must sit at the zip root, which is why
the script zips from inside the staging directory rather than zipping a folder.

Staging exists because the extension root is the repo root, and the repo root is
about 300 MB — `wasm/target` alone is 285. The payload is 1.1 MB, 428 KB zipped.

The script refuses to produce a zip if the wasm module is missing (it is
gitignored, so a fresh clone has none), if `manifest.json` promises a file that
is not there, or if the two `version` fields disagree. `npm run package:zip`
skips the ~20s Rust build when `src/vendor/` is already current.

`npm run icons` regenerates `icons/` — placeholders in the same phosphor palette
as everything else, drawn as rectangles so they stay crisp at 16px. Replace them
with real artwork before any public listing.

## Tests

```sh
npm test
```

28 end-to-end tests in a real browser with the extension loaded: the wasm
module instantiating under the extension CSP, key creation deriving a real
`R…` address, the sealed envelope not containing the WIF, a wrong passphrase
failing, the provider surface being exactly `{isVerusWallet, request}` and
frozen, unknown methods being refused, a request with no key being refused
before any window opens, and the launchpad site swapping its no-wallet notice
for the real form.

Some of those tests exist because of bugs they caught:

- **the popup opened 735px tall and scrolling.** Chrome caps a browser-action
  popup at 600px. The popup drew the create-key and import-key forms
  unconditionally — 426px of one-time setup standing in front of the balance
  every time it was opened. Both now fold away once a key exists, and the
  everyday view is 384px. The test measures content height at the real 360px
  width, because how far the text wraps is the whole question.

- **the provider race.** The site checked `window.verus` synchronously. The
  content script injects the provider with a `<script src>` tag, which loads
  asynchronously, so the page usually ran first and always reported "no wallet".
  The site now waits for the `verus#initialized` event.
- **the WIF assertion that proved nothing.** The original storage test asserted
  the envelope JSON contained no `U`. Base64 contains `U` routinely; the test
  failed for the wrong reason and would have passed for the wrong reason too.
  It now derives a key, seals it, and looks for that key's actual WIF.
- **`channel: 'chromium'` in the harness.** Two plausible alternatives —
  installed Chrome, and bundled Chromium's old headless — both *silently* fail
  to load an unpacked extension. No error, the service worker just never
  appears. Worth knowing before spending an hour on it.

## Security notes, including what is not done

**Done**

- PBKDF2-SHA256 at 600,000 iterations, AES-GCM-256, both from WebCrypto.
  Nothing hand-rolled.
- Key entropy from `crypto.getRandomValues`, never from the wasm module, so the
  module never has to be trusted about where randomness came from.
- The page's request is JSON round-tripped before it is looked at, so getters
  and prototype tricks do not survive.
- The origin is taken from the sender's frame, never from the message body.
- `window.verus` is frozen and non-configurable.
- Everything rendered goes through `textContent`; a currency name is chain data
  and anyone can put a currency on the chain.

**Not done, and you should know before trusting it with real money**

- **No audit.** None of this has been reviewed by anyone.
- **No hardware wallet, no air gap.** `pecu` has the air-gapped flow; this does
  not.
- **The service worker forgets pending approvals** if MV3 stops it while a
  window is open. The window detects it and says so rather than appearing to
  succeed, but the request is lost and must be retried. Persisting it would
  mean writing pending transaction details to disk.
- **No spending limits, no allowlist.** Every request opens a window; there is
  no notion of a trusted site.
- **Mainnet is selectable.** Nothing stops you pointing this at real VRSC. On
  current evidence you should not.

## Licence

Apache-2.0, matching the SDK.
