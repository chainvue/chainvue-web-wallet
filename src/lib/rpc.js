// Talking to a Verus node.
//
// The wasm module deliberately has no HTTP client compiled in — it builds and
// signs, JavaScript fetches. This is the fetching half.

export const NETWORKS = Object.freeze({
  VRSCTEST: { label: 'VRSCTEST', node: 'https://api.verustest.net', native: 'VRSCTEST' },
  VRSC: { label: 'VRSC', node: 'https://api.verus.services', native: 'VRSC' },
});

const NETWORK_KEY = 'verus-wallet.network';

export async function currentNetwork() {
  const stored = await chrome.storage.local.get(NETWORK_KEY);
  return NETWORKS[stored[NETWORK_KEY]] ?? NETWORKS.VRSCTEST;
}

export async function setNetwork(label) {
  if (!NETWORKS[label]) throw new Error(`unknown network: ${label}`);
  await chrome.storage.local.set({ [NETWORK_KEY]: label });
}

/**
 * POST a body the wasm module produced, exactly as it produced it.
 *
 * Both directions are verbatim on purpose. The body is the key the module uses
 * to match a reply to a question, so re-serialising it — even into identical
 * JSON with different key order — breaks the match. And the reply is returned
 * as text including error envelopes, because an error is a real answer to some
 * questions: a flow asking whether a name is free needs the daemon's `-5` to
 * conclude that it is.
 */
/**
 * How long to wait for a node before giving up.
 *
 * A build drives several rounds of requests while the user watches a progress
 * line. Without a deadline one hung connection leaves the approval window
 * saying "asking the node…" forever, with no error and no way to tell a slow
 * node from a dead one — and the user is sitting there waiting to sign.
 */
const TIMEOUT_MS = 20_000;

export async function postRaw(node, body) {
  let response;
  try {
    response = await fetch(node, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body,
    });
  } catch (cause) {
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      throw new Error(`${node} did not answer within ${TIMEOUT_MS / 1000}s — nothing was signed`);
    }
    throw new Error(`cannot reach ${node} — offline, blocked, or the node is down`);
  }
  // Not `response.ok`: a JSON-RPC error arrives with a 500 and a meaningful
  // envelope, and throwing here would discard the answer.
  return response.text();
}

/** An ordinary call, for the wallet's own reads. */
export async function rpc(node, method, params = []) {
  const text = await postRaw(node, JSON.stringify({ jsonrpc: '1.0', id: 'wallet', method, params }));
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${node} did not return JSON`);
  }
  if (body.error) throw new Error(body.error.message ?? 'the node refused the call');
  return body.result;
}

export function broadcast(node, hex) {
  return rpc(node, 'sendrawtransaction', [hex]);
}

/**
 * Every currency held at an address, as `[{id, amount}]` in coins.
 *
 * Reads `currencybalance`, not `balance`. The native coin appears in there
 * too — `balance` is the same figure in satoshis — so the map alone is the
 * complete picture and mixing the two fields would double-count it.
 */
export async function currencyBalances(node, address) {
  const result = await rpc(node, 'getaddressbalance', [{ addresses: [address] }]);
  const held = result?.currencybalance;
  if (!held || typeof held !== 'object') {
    // Older nodes answer with the native balance only. Losing token balances
    // is better than inventing them, but say nothing rather than show zero.
    return [];
  }
  return Object.entries(held)
    .map(([id, amount]) => ({ id, amount: Number(amount) }))
    .filter((entry) => Number.isFinite(entry.amount) && entry.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Outputs at an address that carry a given currency.
 *
 * Needed because a token created by `--supply`-style preallocation belongs to
 * the **defining identity**, not to the key that paid for the launch. Spending
 * it means funding the transaction from the identity's own outputs and letting
 * the identity's primary key sign — the same rule that governs minting.
 *
 * Returns the `Utxo` shape the SDK wants: satoshis as a decimal string, script
 * as hex.
 */
export async function tokenUtxos(node, address, currencyId) {
  const utxos = await rpc(node, 'getaddressutxos', [{ addresses: [address] }]);
  if (!Array.isArray(utxos)) return [];

  return utxos
    .filter((u) => {
      // Reserve outputs report their currencies in a map keyed by id. A plain
      // native output has none and can never fund a token spend.
      const held = u.currencyvalues ?? u.currencynames ?? null;
      return held && Object.prototype.hasOwnProperty.call(held, currencyId);
    })
    .map((u) => ({
      txid: u.txid,
      vout: u.outputIndex ?? u.vout,
      satoshis: String(u.satoshis ?? 0),
      scriptPubKey: u.script ?? u.scriptPubKey,
    }));
}

/**
 * Identities this key controls, with what each one holds.
 *
 * Load-bearing for a launchpad wallet, not a nicety. A token's supply is
 * preallocated to its **defining identity**, never to the address that paid
 * for the launch — so a freshly created coin is invisible in a wallet that
 * only reads its own R-address, and looks like the launch failed. It is the
 * difference between `aaa` (1,000,000,000 on `aaa@`) and a launch that really
 * did mint nothing.
 *
 * `getidentitieswithaddress` wants `{address: …}`; `identityaddress` and
 * `addressorpubkey` are both refused.
 */
export async function controlledIdentities(node, address) {
  let rows;
  try {
    rows = await rpc(node, 'getidentitieswithaddress', [{ address }]);
  } catch {
    return []; // an older node without the method is not an error
  }
  if (!Array.isArray(rows)) return [];

  const found = [];
  for (const row of rows) {
    const id = row?.identityaddress;
    if (!id) continue;
    let held = [];
    try {
      held = await currencyBalances(node, id);
    } catch {
      held = [];
    }
    if (held.length) found.push({ name: row.name, id, held });
  }
  return found;
}

const nameCache = new Map();

/** Resolve currency ids to names, one lookup each, cached for the session. */
export async function currencyNames(node, ids) {
  const missing = ids.filter((id) => !nameCache.has(`${node}:${id}`));
  await Promise.all(
    missing.map(async (id) => {
      try {
        const def = await rpc(node, 'getcurrency', [id]);
        nameCache.set(`${node}:${id}`, def?.fullyqualifiedname ?? def?.name ?? id);
      } catch {
        nameCache.set(`${node}:${id}`, id);
      }
    }),
  );
  return new Map(ids.map((id) => [id, nameCache.get(`${node}:${id}`) ?? id]));
}
