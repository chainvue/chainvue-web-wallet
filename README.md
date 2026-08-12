# chainvue web wallet

A Verus wallet that lives in your browser.

Your keys are created on your own computer and encrypted with a passphrase you
choose. They never leave the machine, and there is no account to sign up for.
Before anything is sent, the wallet shows you the transaction it actually
built — the real fee, the real destination — and nothing goes to the blockchain
until you press Broadcast.

**It has not been audited. Please read [Before you trust it](#before-you-trust-it-with-real-money).**

## What you can do

- Create a wallet, or import one you already have
- See what you hold — coins, tokens, and anything held by identities you control
- Receive: copy your address so someone can pay you
- Send coins or tokens to an address or to a VerusID name like `alice@`
- Claim a VerusID name
- Launch a token or a currency, and convert between currencies

## Install it

There is no Chrome Web Store listing yet, so you install it yourself. It takes
about five minutes, and you only build it once.

### What you need first

- [Node.js](https://nodejs.org) 18 or newer
- [Rust](https://rustup.rs) and `wasm-pack` — the wallet's signing code is
  compiled from Rust, and it is not shipped pre-built:

  ```sh
  curl https://sh.rustup.rs -sSf | sh
  cargo install wasm-pack
  ```

### 1. Build it

```sh
git clone https://github.com/chainvue/chainvue-web-wallet.git
cd chainvue-web-wallet
npm install
npm run package
```

That leaves a folder called **`dist/unpacked`**. This is the wallet.

### 2. Load it into your browser

1. Open your browser's extensions page:
   - **Chrome** — `chrome://extensions`
   - **Brave** — `brave://extensions`
   - **Edge** — `edge://extensions`
   - Any other Chromium browser — `chrome://extensions`
2. Turn on **Developer mode** (a switch, usually top right)
3. Click **Load unpacked**
4. Choose the **`dist/unpacked`** folder

The wallet icon appears in your toolbar. Pin it so it stays visible.

### Which browsers work

Any Chromium browser, version 116 or newer — Chrome, Brave, Edge, Opera,
Vivaldi, Arc.

**Firefox and Safari will not work.** They handle extension background scripts
differently, so the wallet would need changes before it could load there.

## First time

1. Click the wallet icon and choose a name and a passphrase, then **create key**.
2. **Write the passphrase down.** It is the only thing that can open your wallet.
   Nobody — including us — can recover it or reset it for you. If you lose it,
   the coins are gone.
3. The wallet starts on **VRSCTEST**, the test network, where the coins are not
   worth anything. That is the right place to learn it.

To be paid, press **Receive** and copy your address. To pay someone, press
**Send**.

## Before you trust it with real money

- **No audit.** Nobody has reviewed this code for security.
- **No hardware wallet support**, and no air-gapped signing.
- **No spending limits and no trusted sites.** Every request opens a window.
- **Mainnet is selectable.** Nothing stops you pointing it at real VRSC. On
  current evidence, you should not.

What is done: the encryption is the browser's own (PBKDF2-SHA256 at 600,000
iterations, AES-GCM-256) with nothing hand-rolled, and every byte the wallet
signs comes from the Verus Rust SDK, pinned to the same version the `pecu`
command-line tool uses.

## For developers

How it is put together, why the approval happens in two stages, and the
reasoning behind the trust boundaries: **[docs/design.md](docs/design.md)**.

```sh
npm test          # end-to-end tests in a real browser
npm run package   # build the extension into dist/
```

Releases are automatic, and decided by the commit messages. Write
`fix: …` or `feat: …` and a release is proposed; write `docs: …` and nothing
happens. A pull request stays open showing the next version and the changelog,
and merging it is what publishes.

Builds run in GitHub Actions rather than by hand, and every release carries a
SHA-256 so you can check the download is the file CI published. The Rust
toolchain is pinned in `wasm/rust-toolchain.toml` and every dependency in
`wasm/Cargo.lock` — but the build is not yet bit-for-bit reproducible; see
[docs/design.md](docs/design.md#reproducibility).

[Privacy policy](PRIVACY.md) · Apache-2.0, matching the SDK.
