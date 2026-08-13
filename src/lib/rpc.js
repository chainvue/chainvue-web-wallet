// Talking to a Verus node.
//
// The wasm module deliberately has no HTTP client compiled in — it builds and
// signs, JavaScript fetches. This is the fetching half.

/**
 * `oracle` is where the chain publishes its protocol halts.
 *
 * The identity is the chain's own root ID; `upgradeKey` is the VDXF key its
 * upgrade descriptor sits under in that identity's `contentmultimap`, derived
 * per chain as `getvdxfid "vrsc::system.upgradedata"
 * '{"vdxfkey":"<this chain's id>"}'`.
 *
 * **The key is chain-specific and MUST NOT be shared.** Reading one chain's key
 * against another finds an absent entry and reports a halted chain as clear —
 * which is the failure this whole mechanism exists to prevent. Both values were
 * resolved against their own node, not typed from memory. See `lib/halt.js`.
 */
/**
 * `explorerTx` is a prefix, and the wallet never fetches it.
 *
 * It is only ever put on an anchor the user can choose to click, because doing
 * so tells a third party which transaction someone is looking at from which IP.
 * That is a fair trade when it is asked for and not one to make on their behalf,
 * so nothing here is loaded, prefetched or pinged in the background.
 *
 * Both hosts run insight-ui, whose routes are client-side: `/tx/<txid>` is a
 * 404 and `#/tx/<txid>` is the transaction. Confirmed against each host rather
 * than typed from memory — `testex` reports `testnet: true` and `insight`
 * reports the VRSC chain.
 */
export const NETWORKS = Object.freeze({
  VRSCTEST: {
    label: 'VRSCTEST',
    node: 'https://api.verustest.net',
    native: 'VRSCTEST',
    explorerTx: 'https://testex.verus.io/#/tx/',
    real: false,
    oracle: { identity: 'VRSCTEST@', upgradeKey: 'iH51dFy7vF3LTRuVQvCTVu6QSbYfhTjek8' },
  },
  VRSC: {
    label: 'VRSC',
    node: 'https://api.verus.services',
    native: 'VRSC',
    explorerTx: 'https://insight.verus.io/#/tx/',
    // The one field the whole interface changes colour on. A wallet where a
    // screen that spends real money is pixel-identical to one that spends play
    // money is a wallet that will eventually be used on the wrong chain — and
    // the difference was five characters of text in a single chip.
    real: true,
    oracle: { identity: 'VRSC@', upgradeKey: 'iSJ38vYX7qoCtotc9wBHb1vZdR3oTgoHCX' },
  },
});

const NETWORK_KEY = 'verus-wallet.network';

/**
 * A synchronous mirror of the selected chain, for the paint before the read.
 *
 * `chrome.storage.local` is async, so the chain is not known until a promise
 * resolves — and in the popup that is after the 918 KB wasm module has
 * instantiated. The document is on screen for all of that, wearing whichever
 * palette the stylesheet defaults to.
 *
 * On mainnet that means a visible flash of the testnet colours on the one screen
 * whose entire job is to be unmistakable, which gives back most of what the
 * colour was for. `localStorage` is synchronous and available in an extension
 * page, so it can answer at module-evaluation time; it is a cache of an
 * authoritative value and never the value itself — every read of what chain we
 * are on still goes through `currentNetwork`.
 */
const MIRROR = 'verus-wallet.network.cached';

function remember(label) {
  try {
    localStorage.setItem(MIRROR, label);
  } catch {
    // A private mode or a locked-down profile can refuse. The cost is the flash
    // this exists to avoid, which is not a reason to fail.
  }
}

/**
 * Stamp the chain on the root element. Safe to call before anything is awaited.
 *
 * Called again by the popup after the real read, so a stale mirror corrects
 * itself within the same tick rather than persisting.
 */
export function applyChain(label = null) {
  let chosen = label;
  if (!chosen) {
    try {
      chosen = localStorage.getItem(MIRROR);
    } catch {
      chosen = null;
    }
  }
  const real = Boolean(NETWORKS[chosen]?.real);
  document.documentElement.setAttribute('data-chain', real ? 'real' : 'test');
  return real;
}

export async function currentNetwork() {
  const stored = await chrome.storage.local.get(NETWORK_KEY);
  const net = NETWORKS[stored[NETWORK_KEY]] ?? NETWORKS.VRSCTEST;
  remember(net.label);
  return net;
}

export async function setNetwork(label) {
  if (!NETWORKS[label]) throw new Error(`unknown network: ${label}`);
  remember(label);
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
 * The `i…` address behind a friendly name.
 *
 * The daemon wants one form or the other and refuses the wrong one, and the SDK
 * wants the address rather than the name wherever it can have it — resolving
 * here keeps a name lookup out of the signing path. Callers pass a reference
 * already in the daemon's shape (`name@` or `i…`); see `asIdentityRef`.
 */
export async function identityAddress(node, ref) {
  const holder = await rpc(node, 'getidentity', [ref]);
  const address = holder?.identity?.identityaddress;
  if (!address) throw new Error(`no identity called "${ref}"`);
  return address;
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
    if (held.length) found.push({ name: row.name, id, held, spendable: canSignFor(row, address) });
  }
  return found;
}

/**
 * Whether this key can actually move what the identity holds.
 *
 * `getidentitieswithaddress` matches an address in ANY authority — revocation
 * and recovery included — but the SDK's identity spends refuse an identity that
 * does not list the signing key among its *primary* addresses, or that needs
 * more than one signature. Without this distinction the send picker offers
 * identities that fail after the passphrase has been typed.
 *
 * Reported rather than filtered: a balance held under a recovery authority is
 * still worth showing, it just cannot be spent from here.
 *
 * An older node that omits the fields is given the benefit of the doubt. Hiding
 * a real balance because a field is missing is the worse error of the two — the
 * SDK still refuses the spend by name if it turns out not to be signable.
 */
function canSignFor(row, address) {
  const primaries = row?.primaryaddresses;
  if (!Array.isArray(primaries)) return true;
  if (!primaries.includes(address)) return false;
  return (row?.minimumsignatures ?? 1) <= 1;
}

/**
 * What this address has recently done.
 *
 * The most common question a wallet is opened to answer after "what do I have"
 * is "did it go through", and a list that shows only settled history cannot
 * answer it: the minutes when somebody most wants to know are exactly the
 * minutes their transaction is still in the mempool and therefore absent.
 *
 * So three reads, in parallel:
 *
 *   getaddressdeltas   what has confirmed — one row per output touched
 *   getaddressmempool  what has not confirmed yet, which the deltas never show
 *   getblockcount      the tip, so a height becomes a confirmation count
 *
 * A single transaction appears several times in the deltas — a spend and its
 * change are two rows of the same txid with opposite signs — so netting per
 * txid is what turns that into something a person recognises: one line, one
 * direction, one amount.
 *
 * Still deliberately shallow: the newest few, native amounts only. Naming who
 * was paid needs the whole transaction and is a second read, kept out of here
 * so the list can paint before it — see `counterparty`.
 */
export async function recentActivity(node, address, limit = 4) {
  const quietly = (method, params) => rpc(node, method, params).catch(() => null);

  const [deltas, mempool, tip] = await Promise.all([
    // NOT caught, unlike the other two. A failure here used to become an empty
    // list, which the popup renders as "nothing yet" — so an unreachable node
    // told somebody they had never been paid. Letting it throw is what makes the
    // caller able to say "activity unavailable", which is the true statement.
    rpc(node, 'getaddressdeltas', [{ addresses: [address] }]),
    // These two only ever add to the answer: without the mempool nothing is
    // marked pending, and without the tip nothing claims a confirmation count.
    // Both degrade towards "not confirmed yet", which is the safe way to be
    // wrong about money that may not have arrived.
    quietly('getaddressmempool', [{ addresses: [address] }]),
    quietly('getblockcount', []),
  ]);

  const byTx = new Map();

  const net = (rows, pending) => {
    if (!Array.isArray(rows)) return;
    for (const delta of rows) {
      const txid = delta?.txid;
      if (!txid) continue;
      // A transaction seen in both is one that confirmed between the two reads.
      // The confirmed row is the truthful one, so it wins.
      const entry = byTx.get(txid) ?? { txid, satoshis: 0, time: 0, height: 0, pending };
      if (entry.pending && !pending) entry.pending = false;
      entry.satoshis += Number(delta.satoshis) || 0;
      // Mempool rows carry `timestamp` (when it was seen) and no block time.
      entry.time = Math.max(entry.time, Number(delta.blocktime) || Number(delta.timestamp) || 0);
      entry.height = Math.max(entry.height, Number(delta.height) || 0);
      byTx.set(txid, entry);
    }
  };

  net(deltas, false);
  net(mempool, true);

  const height = Number(tip) || 0;

  return [...byTx.values()]
    // A transaction that nets to zero only moved value between this address's
    // own outputs. "Moved 0" is not information, so it is not a row.
    .filter((entry) => entry.satoshis !== 0)
    // Unconfirmed first: it is the one being waited on.
    .sort((a, b) => Number(b.pending) - Number(a.pending) || b.height - a.height || b.time - a.time)
    .slice(0, limit)
    .map((entry) => ({
      txid: entry.txid,
      time: entry.time,
      height: entry.height,
      pending: entry.pending,
      // Zero when the tip is unknown, which reads as "not confirmed yet" — the
      // safe way round to be wrong about money that may not have arrived.
      confirmations: entry.pending || !height || !entry.height ? 0 : height - entry.height + 1,
      // The sign is the direction. A net of zero is a transaction that only
      // moved value between this address's own outputs.
      direction: entry.satoshis > 0 ? 'in' : 'out',
      coins: Math.abs(entry.satoshis) / 1e8,
    }));
}

/**
 * Who was on the other end, as far as the chain can say.
 *
 * "Sent 12.5" answers half a question. The half that makes somebody sure their
 * payment went to the right place is where it went, and that is one address
 * away: `getrawtransaction` verbose carries `vin[].address` and
 * `vout[].scriptPubKey.addresses` on a node with the address index on — which
 * is the same index `getaddressdeltas` already needs, so this asks for nothing
 * new to be enabled.
 *
 * Money going out means the counterparty is an output that is NOT ours; money
 * coming in means it is an input that is not ours. Change is excluded by that
 * rule alone, without having to recognise it.
 *
 * Returns null rather than a guess whenever the chain does not say — a coinbase
 * has no input address, and a shielded input has none by design. A wallet that
 * invented a plausible name for those would be lying at exactly the moment it
 * is being trusted.
 *
 * Separate from `recentActivity` and called per row, because it is one extra
 * read per transaction and the list must not wait on any of them to paint.
 */
export async function counterparty(node, txid, address) {
  let tx;
  try {
    tx = await rpc(node, 'getrawtransaction', [txid, 1]);
  } catch {
    return null;
  }

  const from = (side) => {
    const found = [];
    for (const entry of side ?? []) {
      const addresses = entry?.addresses ?? entry?.scriptPubKey?.addresses ?? [];
      for (const one of addresses) if (one && one !== address && !found.includes(one)) found.push(one);
    }
    return found;
  };

  const outgoing = from(tx?.vout);
  const incoming = from(tx?.vin);

  return { paid: outgoing, paidBy: incoming };
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
