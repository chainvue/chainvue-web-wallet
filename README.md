# chainvue-web-wallet

A non-custodial Verus wallet as a Chrome extension. Keys are encrypted in the
browser, transactions are built and signed in WebAssembly, and every one is
shown *built* — txid, fee, what it burns — before anything is broadcast.

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

The decrypted key exists for the lifetime of one approval window and is freed in
a `finally`. The service worker never sees it. The page never sees it. There is
no method that returns it.

`wasm/src/lib.rs` is one line — `pub use verus_wasm::*`. Every byte this wallet
signs comes from the Verus Rust SDK, pinned by revision to the same commit
`pecu` uses. A wallet that signed differently from the CLI would be a second
implementation of consensus-critical serialisation, which is the thing worth
never having twice.

## Two-stage approval

Most wallets show you what a page *claims* it wants, then sign it. This one does
that, and then shows you what it actually *built* — the real txid, the real fee,
the currency id a launch will create — with nothing yet sent. Broadcast, or
discard.

Stage two exists because a request is a claim and a built transaction is a fact.

## The page names a currency; the wallet asks the rest

```js
await window.verus.request({ method: 'verus_convert', params: [{ into: 'dudecoin' }] });
```

That is the whole request. A `verus_convert` missing its source or its amount
opens a form in the approval window: which of your coins to spend, how much,
which side of the trade the named currency is on, and an estimate quoted through
whichever basket pays best.

It works that way because a site cannot know the answer. Balances sit behind an
address no page is given, so a page that fills the trade in is guessing at the
one thing that decides whether the trade is possible at all. The wallet has the
address and can read them.

Whatever the page does supply becomes a starting value, and a fully specified
request still builds without asking anything — the form is a way of *filling in*
a request, not a second way of making one, and what it produces goes down the
same path as before.

Routes come from `listcurrencies`, once per window: there is no reverse index on
chain, and "which baskets hold this currency" is the first question a conversion
has to answer.

## Build

The wasm module is not committed; build it first.

```sh
npm install
npm run build:wasm    # ~20s, needs rustup + wasm-pack + wasm32-unknown-unknown
npm test              # 28 end-to-end tests, real browser, extension loaded
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → this
directory.

`npm run package` builds the Chrome Web Store zip;
[`store/listing.md`](store/listing.md) has everything else a submission needs.

## Before trusting it with real money

- **No audit.** None of this has been reviewed by anyone.
- **No hardware wallet, no air gap.** `pecu` has the air-gapped flow; this does
  not.
- **No spending limits, no allowlist.** Every request opens a window; there is
  no notion of a trusted site.
- **The service worker forgets pending approvals** if MV3 stops it while a
  window is open. The window says so rather than appearing to succeed, but the
  request is lost and must be retried.
- **Mainnet is selectable.** Nothing stops you pointing this at real VRSC. On
  current evidence you should not.

What *is* done: WebCrypto only — PBKDF2-SHA256 at 600,000 iterations and
AES-GCM-256, nothing hand-rolled. Entropy from `crypto.getRandomValues`, never
from the wasm module. The page's request JSON round-tripped before it is looked
at. The origin taken from the sender's frame, never the message body.
`window.verus` frozen and non-configurable. Everything rendered through
`textContent`, because a currency name is chain data and anyone can put a
currency on the chain.

[`PRIVACY.md`](PRIVACY.md) · Apache-2.0, matching the SDK.
