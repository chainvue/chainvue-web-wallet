# How it is put together

The reasoning that used to live in the README, kept here so the front page can
be about installing the thing.

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

## Sending is started in the wallet, never by a page

`wallet_send` is deliberately not in `PAGE_METHODS`, and the page-facing and
local vocabularies are kept apart. Every page-callable method either pays a
protocol fee or pays the user's own address — `planConvert` is handed
`recipient: key.address()` rather than anything the page asked for, because a
page that could name the recipient could route a swap into its own wallet.
Putting a send on the page allowlist would hand that back.

The approval window says which it is: a site request names its origin in amber,
a send you started reads "no website asked for this" in green. The discriminator
is a `local` flag the worker sets, not the origin string — no page can produce
the flag.

## Destinations are checked before anything is built

A single mistyped character keeps an address's prefix and its length. It yields
a valid script paying a hash nobody holds the key for, the chain accepts it, and
the coins are gone with no bounce — so a prefix-and-length regex catches nothing
that matters. `src/lib/address.js` verifies the base58check checksum, and
addresses are displayed grouped with the ends emphasised because those are the
characters anyone actually compares against their source.

Shielded (`z…`) addresses are refused with the real reason: the SDK has no
shielded support at all, so this is not a gap to work around.

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

## Whether the chain is taking conversions at all

Verus can disable conversions chain-wide, and when it does nothing else changes
shape — baskets still list, prices still quote, and a conversion still plans,
funds and signs. The chain then refuses it at broadcast with
`bad-txns-failed-precheck`, which names neither the switch nor the reason.

So the switch itself is read, from the chain's notification oracle, and a halt is
reported before a passphrase is asked for rather than after. In the daemon this
is `CConnectedChains::CheckOracleUpgrades` in `src/pbaas/pbaas.cpp`, keyed on
`vrsc::system.upgradedata.disabledefi`; the key is derived per chain and must
never be shared between them. See `src/lib/halt.js`.

`disabledefi` has been in force on VRSCTEST since block 1,187,000 and on VRSC
since block 4,163,035.

## Security posture

Done:

- PBKDF2-SHA256 at 600,000 iterations and AES-GCM-256, both from WebCrypto.
  Nothing hand-rolled.
- Key entropy from `crypto.getRandomValues`, never from the wasm module, so the
  module never has to be trusted about where randomness came from.
- The page's request is JSON round-tripped before it is looked at, so getters
  and prototype tricks do not survive.
- The origin is taken from the sender's frame, never from the message body.
- `window.verus` is frozen and non-configurable.
- Everything rendered goes through `textContent`; a currency name is chain data
  and anyone can put a currency on the chain.

Not done, and worth knowing:

- **No audit.** None of this has been reviewed by anyone.
- **No hardware wallet, no air gap.** `pecu` has the air-gapped flow; this does
  not.
- **No spending limits, no allowlist.** Every request opens a window; there is no
  notion of a trusted site.
- **The service worker can forget a pending approval** if MV3 stops it while a
  window is open. The window says so rather than appearing to succeed, but the
  request is lost and must be retried. The approval window holds a port open to
  make this rare.
- **Mainnet is selectable.** Nothing stops you pointing this at real VRSC.

## Packaging

`npm run package` builds the wasm, stages `manifest.json` + `src/` + `icons/`
into `dist/unpacked`, verifies every path the manifest promises, and zips it.
[`store/listing.md`](../store/listing.md) has everything else a Chrome Web Store
submission needs.

## Releases

Two workflows, split along one line: what the version should be, and what the
artifact is.

`release-please.yml` reads the commit messages and keeps a pull request open
saying what the next version would be and what changed. Only `feat:` and `fix:`
(and anything breaking) move the number — a `docs:` or `chore:` commit proposes
nothing, so editing the README releases nothing. Merging that PR writes
`CHANGELOG.md`, bumps `package.json` and `manifest.json` together, tags, and
publishes the release.

Below 1.0 a breaking change bumps the minor rather than the major
(`bump-minor-pre-major`), because 1.0 should mean audited and on the Chrome Web
Store rather than a number reached by accident.

The open pull request is the point, not an inconvenience: it is the last look at
what is about to become public, and it means nothing ships off a commit message
typed in a hurry.

`release.yml` then builds the extension and attaches the zip and its SHA-256. It
handles both a release published by release-please and a tag pushed by hand, so
it creates the release only when one does not already exist and otherwise just
uploads — and it refuses to publish if the tag disagrees with `manifest.json`.
`npm run bump` exists for the hand-tagged path.

Only `release-please.yml` uses a third-party action, and it is pinned to a commit
SHA. It reads commit messages and opens a pull request; it never touches the
build. Everything that can reach the artifact is first-party.

Built in CI rather than on a laptop on purpose: the artifact then comes from a
public commit through a process anyone can read, which is what makes the
checksum worth publishing. Two things make the build reproducible and both are
load-bearing — `wasm/Cargo.lock`, because pinning the SDK by revision pins only
that crate and leaves every dependency under it (including the crypto) free to
resolve differently on another day, and `wasm/rust-toolchain.toml`, because
codegen changes between compiler releases.

A GitHub Release still means Developer mode and manual updates. The Chrome Web
Store is the only route that gives one-click install and automatic updates —
which matters for a wallet, where a security fix nobody installs is not a fix.
Unlisted is reviewed identically to public and is installable by link without
being searchable.
