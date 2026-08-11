# Privacy policy

**chainvue web wallet**
Last updated: 12 August 2026

## The short version

This extension has no server. There is nothing for it to send data to, and it
sends none. Your keys are encrypted and stored on your own machine, and the only
thing that ever leaves it is the traffic required to read the Verus blockchain
and to broadcast a transaction you have explicitly approved — and that traffic
goes to a public Verus node, not to us.

There is no account, no telemetry, no analytics, no crash reporting, no
advertising, and no third-party SDK of any kind.

## What is stored, and where

Everything below is held in `chrome.storage.local` on your own computer. None of
it is transmitted anywhere.

**Your private keys.** Encrypted with AES-GCM-256 under a key derived from your
passphrase with PBKDF2-SHA256 at 600,000 iterations, using the browser's own
WebCrypto implementation. The passphrase itself is never stored, in any form —
it exists only in the window you typed it into, for as long as that window is
open. A decrypted key exists only inside the approval window, only for the
duration of the operation you approved, and is destroyed when that operation
finishes.

We cannot recover your key or your passphrase. Nobody can. If you lose the
passphrase, the funds that key controls are gone.

**Your key labels and public addresses.** Stored unencrypted, so the extension
can list your keys and show balances without asking for a passphrase every time
you open it. A public address is public by definition.

**Which network you selected.** Testnet or mainnet.

**VerusID registrations that are part-finished.** Claiming a name on Verus takes
two transactions, a block apart. The salt that links them exists only in this
record and cannot be recovered from the blockchain by anyone, including us. If
it is lost after the first transaction, the registration fee is spent and cannot
be reclaimed — which is why it is written to storage rather than kept in memory.
It is deleted as soon as the second transaction is broadcast, and you can delete
it manually from the extension's popup at any time.

## What is sent, and to whom

The extension communicates with exactly one category of external service: a
public Verus blockchain node, at whichever of these two endpoints matches the
network you have selected.

- `https://api.verustest.net` — Verus testnet
- `https://api.verus.services` — Verus mainnet

These are operated by the Verus community, not by us, and their handling of the
requests they receive is outside our control and governed by their own policies.

What is sent to them, and only when the corresponding action requires it:

- **Your public address**, to read balances, unspent outputs, and the identities
  it controls.
- **Currency and identity names**, to resolve them to their on-chain
  identifiers.
- **Signed transaction data**, when — and only when — you press "broadcast" on a
  transaction the extension has shown you in full.

Requests are sent with credentials omitted, so no cookies accompany them. Your
private keys, your passphrase, and the registration salt described above are
never included in any request, under any circumstances. There is no code path
that transmits them.

Be aware of what a public blockchain is: once a transaction is broadcast, it is
permanently and publicly recorded, and it is not private. That is a property of
the blockchain, not of this extension.

## What websites can see

The extension injects a small provider object at `window.verus` into pages you
visit, so that a website can ask the wallet to do something. This is the same
mechanism used by every browser wallet.

A website can:

- see that a Verus wallet is installed;
- ask for your public address, and receive it;
- ask the wallet to build a transaction, which opens an approval window that you
  must act on.

A website **cannot**:

- read your private key, your passphrase, or your registration salt — there is
  no method that returns any of them;
- cause anything to be signed or broadcast without you typing your passphrase
  and approving the built transaction;
- choose where a conversion pays out — the recipient is always your own address;
- misrepresent which site it is, since the origin shown to you is taken from the
  browser frame the request came from and not from anything the page supplied.

The content script that performs this injection does not read page content,
form input, cookies, browsing history, or the DOM. It listens on a single named
message channel and forwards what it receives.

## What is not collected

To be explicit, because "we collect nothing" is a claim worth itemising:

no personally identifiable information; no name, email address, or age; no
location; no browsing or search history; no data about which websites you visit;
no user activity or interaction analytics; no crash or diagnostic reports; no
device or browser fingerprint; no health data; no personal communications.

## Data sale and sharing

Your data is not sold, shared, rented, or transferred to any third party. It is
not used for creditworthiness or lending purposes. It is not used for any purpose
unrelated to the extension's single stated function, which is to hold your keys
and to build, show and sign Verus transactions at your instruction.

## Deleting your data

Removing a key from the popup deletes its encrypted envelope. Removing the
extension from Chrome deletes everything it stored, including your keys.

**Both are irreversible.** If a key is not backed up elsewhere, deleting it
destroys access to whatever it holds. There is no copy anywhere else, because
there is nowhere else.

## Security, honestly

The cryptography is the browser's own WebCrypto, and the transaction signing
comes from the Verus Rust SDK compiled to WebAssembly, pinned to the same
revision the `pecu` command-line tool uses. Nothing is hand-rolled.

None of it has been independently audited. The full source is published under
Apache-2.0 and is small enough to read in an afternoon. Please do, before
trusting it with anything you cannot afford to lose.

## Changes

Material changes to this policy will be published with an updated date at the
top and in the extension's release notes.

## Contact

Issues and questions:
<https://github.com/chainvue/chainvue-web-wallet/issues>
