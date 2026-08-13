# Chrome Web Store submission

Everything the dashboard asks for, written out so it can be pasted rather than
improvised at 1am into a form that has no draft-saving worth relying on.

Field limits are the store's, checked with `node scripts/listing-check.mjs`.

> **Read this first.** The wallet is unaudited and mainnet is selectable. The
> copy below says so, in the summary and again in the description, on purpose —
> not as a disclaimer to bury but because it is true and a reviewer will read
> the linked README anyway. If a marketing instinct says to cut it, the thing to
> change is the audit status, not the sentence.

---

## Store listing

### Item name — 75 max

```
chainvue web wallet
```

### Summary — 132 max

```
Non-custodial Verus wallet. Keys encrypted in your browser; every transaction shown built — txid and fee — before it sends.
```

### Category

**Developer Tools.**

Not a neutral choice. This is a developer-facing tool and it is unaudited;
listing it where developers look, rather than under something that reads as
consumer finance, sets the right expectation about who it is for. Revisit after
an audit, not before.

> **The name drops "Verus", and store search will notice.** People look for
> "verus wallet". The word still appears in the summary, the description and the
> manifest description, all of which are indexed — but the item name is weighted
> most heavily, so expect to be found by brand rather than by chain. That is a
> reasonable trade for a house name across chainvue's tools; it is a trade, not
> a free move.

### Language

English (UK spelling throughout the UI — "sanitise", "serialisation" — so pick
`en_GB` if it is offered).

### Detailed description — 16,000 max

```
A non-custodial wallet for the Verus blockchain. Your keys are generated and
encrypted in your own browser. There is no account, no server, and no method —
anywhere in the extension — that hands a key back to a website.

TWO-STAGE APPROVAL

Most wallets show you what a page claims it wants, then sign it. This one does
that, and then shows you what it actually built.

  1. The request. The origin that asked, the action, and the page's own
     description of it. You type your passphrase and press Build.

  2. The transaction. The real txid. The real fee. The currency id a launch will
     create and the block it starts at. Nothing has left your machine yet —
     broadcast it, or discard it.

The second stage exists because a request is a claim and a built transaction is
a fact. Signing straight from a page's description means approving what the page
said, not what the wallet made.

WHERE THE KEYS ARE

Encrypted with AES-GCM-256 under a key stretched from your passphrase with
PBKDF2-SHA256 at 600,000 iterations — both from the browser's own WebCrypto, and
nothing hand-rolled. Key material comes from crypto.getRandomValues, so the
WebAssembly module never has to be trusted about where randomness came from.

A key is decrypted only inside the approval window, only after you have typed
the passphrase, and is freed the moment the operation finishes. The background
service worker never sees it. The page never sees it.

SIGNING IS THE SDK'S, NOT OURS

Every byte this wallet signs comes from the Verus Rust SDK, compiled to
WebAssembly and pinned by revision to the same commit the pecu CLI uses. The
wrapper crate is one line of Rust. A wallet that signed differently from the CLI
would be a second implementation of consensus-critical serialisation, which is
the thing worth never having twice.

WHAT IT DOES

  • Create or import a key, encrypted under a passphrase — and back it up, so
    it survives losing the browser
  • Keep several accounts and switch between them
  • Know which chain you are on: mainnet is a different colour, and switching
    into it asks first
  • See every currency at your address — not just the native coin — including
    balances held by identities you control
  • See what a balance is worth, priced by Verus itself: the bridge.vETH basket
    quotes it in DAI. No price API, no extra host, no third party told that you
    opened your wallet
  • Send coins or tokens to an address or to a VerusID name, with the
    destination checked before anything is built, and the last few people you
    paid offered back as one tap
  • Be paid: a QR code and the full address, grouped so it can be checked
  • See recent activity — how much, to or from whom, and whether it has
    confirmed yet
  • Claim a VerusID name, resumably, across the two transactions it takes
  • Launch a token or a basket currency
  • Preconvert into a launch, or swap between currencies
  • Move a preallocated token out of the identity that holds its supply

WHAT IT DOES NOT DO, AND YOU SHOULD KNOW BEFORE TRUSTING IT WITH REAL MONEY

  • It has not been audited. By anyone.
  • There is no hardware wallet support and no air-gapped flow.
  • There are no spending limits and no allowlist. Every request opens a window;
    there is no notion of a trusted site.
  • Mainnet is selectable, and nothing stops you pointing it at real VRSC.

It is free software under Apache-2.0 and the whole of it — about 1,400 lines —
is readable in an afternoon. If you are going to hold value in it, read it.

Source: https://github.com/chainvue/chainvue-web-wallet
```

### URLs

| Field | Value |
| --- | --- |
| Homepage | `https://github.com/chainvue/chainvue-web-wallet` |
| Support | `https://github.com/chainvue/chainvue-web-wallet/issues` |
| Privacy policy | `https://github.com/chainvue/chainvue-web-wallet/blob/main/PRIVACY.md` |

All three resolve on the public repo. Reviewers open them, and a 404 is a
rejection — so if the repo is ever renamed or made private, these are the first
things to fix. A rendered `PRIVACY.md` on GitHub is accepted in practice; GitHub
Pages is tidier if it ever wants a nicer home. What is not accepted is a link
behind a login.

---

## Screenshots

At least one, up to five, at **1280×800** or **640×400**. PNG or JPEG, no alpha,
and no text baked in that repeats what the description already says.

The wallet is a 360px popup and a 400px approval window, so a raw capture is a
narrow strip on a huge canvas. Compose each shot as the window centred on a flat
`#000600` background — the same colour the UI already uses, so the padding reads
as deliberate rather than as a screenshot that failed to fill the frame.

Four worth having, in this order — the first is the one most people see:

1. **The built transaction.** Stage two, with a real txid, a real fee and
   "nothing has been sent yet" visible. It is the thing that distinguishes this
   wallet, so it goes first.
2. **The approval request.** Stage one — origin, action, passphrase field.
   Shows what a site can and cannot ask for.
3. **The popup with balances.** A key with several currencies, including the
   "held by your identities" section. That section is load-bearing: a freshly
   launched token is invisible without it.
4. **A claim in progress.** The pending panel, showing that an interrupted
   registration is visible and recoverable.

Four are in `store/screenshots/`, at 1280×800: `balances.png`, `approve.png`,
`send.png`, `receive.png`. Each is the real UI captured from the loaded
extension and composed on the wallet's own ground, with a short caption that
adds something rather than repeating the description.

Captured at 4× and composed at 2×, then halved — every step is a reduction, so
the type stays sharp. Each capture is cropped to the height of what is actually
drawn; a view longer than the frame fades at the bottom rather than being cut,
because a hard edge reads as a broken screenshot while a fade reads as a wallet
you can scroll.

`claim.png` was dropped: the claims-in-progress panel sits below the fold on a
wallet with real balances, so the screenshot did not show what its caption
promised.

Still missing: the built transaction, stage two. It needs a funded testnet key
so the txid and fee are real, and faking one is a policy problem rather than a
taste one — a screenshot has to match what installs.

---

## Privacy practices

### Single purpose

```
A wallet for the Verus blockchain. It stores the user's private keys encrypted
in the browser, and builds, displays and signs Verus transactions when a website
requests one through the window.verus provider. Every signing operation requires
the user to type their passphrase and to approve the built transaction before it
is broadcast.
```

### Permission justifications

**`storage`**

```
Stores the user's encrypted key envelopes in chrome.storage.local, and nothing
else that is not listed here. Each envelope is AES-GCM-256 ciphertext under a
PBKDF2-SHA256 key at 600,000 iterations; the label and public address are stored
in clear so the popup can list keys and show balances without asking for a
passphrase.

It also stores VerusID registrations that are between their two transactions.
Claiming a name takes a commitment and then a reveal, a block apart, and the
salt linking them exists only in that record — it is not recoverable from the
blockchain by anyone. Losing it means the registration fee is spent with nothing
to show for it, which is why it is persisted rather than kept in memory.

Nothing in storage is transmitted anywhere. The extension has no server and no
account system.
```

**`host_permissions`: `https://api.verustest.net/*`, `https://api.verus.services/*`**

```
The wallet reads chain state and broadcasts signed transactions over JSON-RPC to
a Verus node: address balances, currency definitions, block height, commitment
confirmations, and sendrawtransaction. These two hosts are the public Verus
testnet and mainnet API endpoints, and the user chooses which network is active.

The WebAssembly module deliberately has no HTTP client compiled into it — it
builds and signs, and JavaScript does the fetching — so these are the only two
hosts the extension ever contacts. Requests are sent with credentials omitted.
```

**Content script host access: `http://*/*` and `https://*/*`**

This is the one that will attract the most attention. Answer it directly:

```
The content script injects a provider object at window.verus so that a page can
ask the wallet to sign something — the same pattern as window.ethereum. It is
declarative injection at document_start on the top frame only, and it is the
only way a page can reach a wallet at all.

What it does on the page is narrow and complete: it listens for
window.postMessage on one named channel and forwards those messages to the
extension. It does not read page content, the DOM, cookies, storage, or form
input, and it writes nothing to the page beyond the provider object itself. The
provider is frozen and non-configurable, exposes exactly {isVerusWallet,
request}, and has no method that returns a key or signs without showing the user
the built transaction first.

The origin recorded for every request is taken from the sender's frame, never
from the message body, so a page cannot claim to be a different site.
```

> If review pushes back — and it might — the fix is small and worth taking:
> narrow `matches` in `manifest.json` to the origins this actually serves.
> All-sites injection is what a general-purpose wallet needs; a launchpad
> companion arguably does not. That is a product decision, so it is flagged
> here rather than made.

**Remote code**

```
No. All JavaScript and the WebAssembly module are contained in the package.
Nothing is fetched and executed, nothing is eval'd, and the extension pages run
under script-src 'self' 'wasm-unsafe-eval'. The provider is injected as a
packaged file reference rather than as a string, so no page ever evaluates a
script this extension composed at runtime.
```

### Data use disclosures

The form asks what the item *collects*, meaning data that leaves the user's
device. Nothing here is transmitted to the developer — there is nowhere to
transmit it to. But two categories are worth declaring anyway rather than
answering a flat "none":

| Category | Declare | Why |
| --- | --- | --- |
| Authentication information | **Yes** | Private keys are stored, encrypted, on the device. They are never transmitted, but a reviewer who finds key handling behind a "collects nothing" answer will read it as concealment. |
| Financial and payment information | **Yes** | Public addresses and transaction hex are sent to a public Verus node — a third party — to read balances and to broadcast. |
| Personally identifiable information | No | None is asked for or derivable. |
| Health, location, web history, user activity, personal communications | No | None touched. |

Use the "how it is handled" box to say plainly: stored locally, encrypted,
transmitted only to the public blockchain node the user selected, never to the
developer.

All three certifications apply and are true: no sale to third parties; no use
for any purpose unrelated to the single purpose above; no use for
creditworthiness or lending.

---

## Distribution

**Start Unlisted.** Reviewed exactly like a public listing, installable by
anyone with the link, invisible in search and browse. It can be promoted to
Public later without creating a new item or losing the install base.

For an unaudited wallet whose own README says you should not point it at real
VRSC, discoverability is the part to defer. Public search is what puts it in
front of people who will not read the security notes.

**Trader status.** The EU's DSA requires every developer to declare whether they
are a trader. Free and non-commercial is typically non-trader, but the answer
depends on the account rather than on this item, and getting it wrong stalls
distribution in the EU.

---

## Before uploading

- [x] `fix/popup-height` merged — the popup now renders 429px fresh, 384px with
      a key, against Chrome's 600px cap
- [ ] `manifest.json` and `package.json` versions bumped together
- [ ] Real icons replacing the generated placeholders
- [ ] `npm run package`, then `dist/unpacked` loaded in `chrome://extensions`
      and clicked through — the staged copy, not the repo
- [ ] `npm test` green
- [ ] Privacy policy live at a public URL that does not require a login
- [ ] Source and support URLs resolve
