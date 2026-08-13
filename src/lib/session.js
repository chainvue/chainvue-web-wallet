// Staying unlocked, briefly, on purpose.
//
// # What this weakens, stated plainly
//
// Without it, nothing in this extension can decrypt a key unless somebody types
// a passphrase into the window that is about to sign. That is a real property
// and this gives some of it up: for a few minutes, something in the extension
// can open one envelope without being asked again.
//
// It is here because the alternative is worse in practice. Paying three people
// means typing a long passphrase three times in ninety seconds, and the way that
// actually ends is with a short passphrase — which weakens the same boundary
// permanently, and everywhere, rather than briefly and for one key.
//
// # Why these bits and not the passphrase, and not the WIF
//
// What is held is the PBKDF2 output for ONE envelope:
//
//   * not the passphrase — so it cannot be tried against anything else the user
//     has ever used it for, which is the damage that actually spreads;
//   * not the WIF — so it is not directly spendable, and it is useless without
//     the envelope it was derived against;
//   * salted per envelope — so unlocking one key does not unlock another.
//
// # Why `chrome.storage.session`
//
// It lives in memory, never touches disk, and is cleared by the browser when the
// browser closes. That last part is not a convention this code has to remember
// to honour; it is the storage area's definition. Access is restricted to
// trusted contexts, so a content script — the only attacker-adjacent code this
// extension runs — cannot read it even by name.
//
// It also survives service-worker eviction, which the worker's own memory does
// not. An unlock that evaporated every thirty seconds would be a feature that
// silently did not work.

const KEY = 'verus-wallet.unlock';

/** Short enough that walking away ends it; long enough to pay three people. */
export const MINUTES = 5;

/**
 * Deny content scripts explicitly.
 *
 * `TRUSTED_CONTEXTS` is already the default. Setting it anyway means the
 * guarantee is written down in the code that depends on it rather than inherited
 * from a default that a future manifest change could quietly move.
 */
async function restrict() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chrome without the method still defaults to trusted-only.
  }
}

/** Everything currently unlocked, dropping anything past its expiry. */
async function live() {
  const stored = await chrome.storage.session.get(KEY);
  const held = stored[KEY];
  if (!held || typeof held !== 'object') return {};

  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(held).filter(([, entry]) => Number(entry?.until) > now));
  // Written back so an expired unlock is gone from memory rather than merely
  // ignored on read.
  if (Object.keys(kept).length !== Object.keys(held).length) {
    await chrome.storage.session.set({ [KEY]: kept });
  }
  return kept;
}

/**
 * Remember an unlock for one key.
 *
 * @param {string} label which key
 * @param {string} bits base64 of the derived bits, from `vault.unlockBits`
 */
export async function hold(label, bits) {
  await restrict();
  const kept = await live();
  kept[label] = { bits, until: Date.now() + MINUTES * 60_000 };
  await chrome.storage.session.set({ [KEY]: kept });
}

/**
 * The unlock for one key, or null.
 *
 * Deliberately does NOT extend the expiry on use. An unlock that renewed itself
 * every time it was used would last as long as somebody kept working, which is
 * exactly the case where it should be lapsing.
 */
export async function held(label) {
  const kept = await live();
  const entry = kept[label];
  if (!entry?.bits) return null;
  return { bits: entry.bits, until: Number(entry.until) };
}

/** How long is left, in whole minutes, rounded up. Zero when nothing is held. */
export function minutesLeft(until) {
  const left = Number(until) - Date.now();
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

/** Forget one key's unlock, or every one of them. */
export async function release(label = null) {
  if (label === null) {
    await chrome.storage.session.remove(KEY);
    return;
  }
  const kept = await live();
  if (!(label in kept)) return;
  delete kept[label];
  await chrome.storage.session.set({ [KEY]: kept });
}
