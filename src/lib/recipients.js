// Who this wallet has actually paid.
//
// # Why it exists
//
// Every payment started by pasting thirty-four characters, every time, even to
// somebody paid last week. That is the difference between a wallet used twice
// and one used weekly, and it is also a safety property rather than only a
// convenience: an address recalled from a previous successful payment is one
// that was already checked and already worked, so it cannot be the one the
// clipboard hijacker swapped a moment ago.
//
// # Why it records the broadcast and not the attempt
//
// Written from the approval window once the node has accepted the transaction,
// never from the form. A list built from what was typed would fill up with
// abandoned attempts, typos that failed validation later, and destinations that
// were rejected on the confirmation screen — and would then offer them back as
// "recent recipients", which is precisely the wrong thing to make one click away.
//
// # What is stored
//
// The destination as the person wrote it: `alice@` stays `alice@` rather than
// becoming the `i…` address it resolved to, because the name is the thing they
// will recognise next time and the resolution happens again at signing anyway.
//
// It is local, it never leaves the extension, and it is a list of addresses the
// user has already paid — so it discloses nothing that is not already in this
// wallet's own history. It is still clearable, because "who have you paid" is a
// reasonable thing to want off a shared machine.

const KEY = 'verus-wallet.recipients';

/** Short on purpose: a list to glance at, not an address book. */
const KEEP = 5;

/** Long enough for any address or name, short enough that junk cannot bloat storage. */
const MAX_LENGTH = 120;

async function all() {
  const stored = await chrome.storage.local.get(KEY);
  const found = stored[KEY];
  return found && typeof found === 'object' ? found : {};
}

/** Most recently paid first. */
export async function list(network) {
  const found = (await all())[network];
  return Array.isArray(found) ? found.filter((entry) => typeof entry === 'string') : [];
}

/**
 * Record a destination that was paid.
 *
 * Idempotent and order-updating: paying the same person again moves them to the
 * front rather than adding a duplicate, so the list stays a list of people
 * rather than a log of payments.
 */
export async function remember(network, destination) {
  const value = String(destination ?? '').trim();
  if (!value || value.length > MAX_LENGTH) return;

  const found = await all();
  const kept = [value, ...(found[network] ?? []).filter((entry) => entry !== value)].slice(0, KEEP);
  await chrome.storage.local.set({ [KEY]: { ...found, [network]: kept } });
}

export async function clear(network) {
  const found = await all();
  if (!found[network]) return;
  const { [network]: _dropped, ...rest } = found;
  await chrome.storage.local.set({ [KEY]: rest });
}
