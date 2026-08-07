// Registrations caught between their two transactions.
//
// # Why this file is the most dangerous one here
//
// Claiming a name takes two transactions a block apart: a commitment that
// hides the name behind a salted hash, then a reveal that spends it. The salt
// exists only in the `pending` blob the SDK hands back — it is **not**
// recoverable from the chain, by anyone, ever.
//
// Lose it after the commitment is broadcast and the registration fee is spent
// with nothing to show for it and no way to redeem it. So the rule this module
// exists to enforce is: **persisted before broadcast, never the other way
// round.** `remember()` is called first and its promise awaited; only then may
// a caller post the commitment.
//
// Kept per network. A commitment made on testnet means nothing on mainnet, and
// resuming one against the wrong chain would spend a second fee.

const STORE_KEY = 'verus-wallet.pending';

function slot(network, name) {
  return `${network}:${name}`;
}

async function all() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  const held = stored[STORE_KEY];
  return held && typeof held === 'object' ? held : {};
}

/**
 * Store a registration in progress.
 *
 * Await this before broadcasting. If it throws, do not broadcast: an
 * unpersisted commitment is a burnt fee.
 */
export async function remember(network, name, record) {
  const held = await all();
  held[slot(network, name)] = { ...record, network, name, savedAt: Date.now() };
  await chrome.storage.local.set({ [STORE_KEY]: held });
}

export async function recall(network, name) {
  const held = await all();
  return held[slot(network, name)] ?? null;
}

/**
 * Drop a finished registration.
 *
 * Only ever called after the reveal is broadcast. A commitment that failed is
 * deliberately left behind — it can still be retried, and forgetting it is the
 * one action that makes the fee unrecoverable.
 */
export async function forget(network, name) {
  const held = await all();
  delete held[slot(network, name)];
  await chrome.storage.local.set({ [STORE_KEY]: held });
}

export async function list(network) {
  const held = await all();
  return Object.values(held).filter((r) => !network || r.network === network);
}
