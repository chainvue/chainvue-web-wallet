// Working out what a conversion could be, before anyone asks the wallet to sign one.
//
// # Why the wallet does this and not the page
//
// A page can describe a trade but cannot know whether the reader can pay for
// it: balances live behind an address the page never sees, and the launchpad's
// own RPC proxy does not even allow the call. The wallet has the address, has
// unrestricted access to the node, and is the only context that knows which key
// is about to sign. So it is the right place to ask "which of your coins can
// you spend on this, and what would you get".
//
// # The one rule that matters
//
// `via` names the basket a reserve-to-reserve trade routes through. It is
// REQUIRED for that kind and REFUSED for the other two — verified against the
// daemon, which answers a misplaced one with:
//
//     To specify a fractional currency converter, "currency" and "convertto"
//     must both be reserves of "via"
//
// Getting it wrong is not a visible failure. It throws while building, inside
// this window, after the reader has typed a passphrase — so the derivation is
// one small function with a truth table beside it in `tests/convert.test.mjs`.

import { rpc } from './rpc.js';

/**
 * How far below the estimate the build is told to refuse.
 *
 * A floor, not a guarantee: consensus does not enforce it. Every conversion in
 * a block settles together at one price computed at the block boundary, so the
 * rate moves between the quote and the signature — including because of other
 * people's trades in the same block. The SDK refuses to sign if the node's own
 * estimate has already fallen below this, and that is the only price check that
 * exists anywhere.
 */
export const SLIPPAGE = 0.01;

/** How long the amount box settles before the node is asked anything. */
export const QUOTE_DEBOUNCE_MS = 300;

/**
 * The reserve transfer fee, in native coins — and it is **not one number**.
 *
 * A conversion carries 0.0002001; a preconvert carries 0.0002. Both come from
 * the SDK's daemon-matching tests, which build each kind and assert the bytes
 * against what the daemon itself produces:
 *
 *     a_reserve_into_a_fractional_matches_the_daemon      20_010
 *     a_fractional_into_a_reserve_matches_the_daemon      20_010
 *     a_reserve_to_reserve_conversion_matches_the_daemon  20_010
 *     a_preconvert_matches_the_daemon                     20_000
 *     a_burn_matches_the_daemon                           20_000
 *
 * `ReserveTransfer::fee` in the SDK says it plainly: chain policy, not a
 * constant.
 *
 * # What is established here, and what is not
 *
 * What the daemon **charges** is established. What it **refuses** is not:
 * whether 20_000 on a conversion is actually rejected has never been tested,
 * and cannot be while `disabledefi` is in force — see `lib/halt.js`. pecu has
 * used the flat 0.0002 throughout.
 *
 * So matching the daemon is chosen as the safe direction rather than the
 * proven one. Ten satoshis too many cannot fail; ten too few might.
 */
const CONVERSION_TRANSFER_FEE = '0.0002001';
const PRECONVERT_TRANSFER_FEE = '0.0002';

export function transferFee(kind) {
  return kind === 'preconvert' ? PRECONVERT_TRANSFER_FEE : CONVERSION_TRANSFER_FEE;
}

/**
 * What a conversion costs in the chain's own coin, beyond the amount itself.
 *
 * The transfer fee rides inside the reserve transfer; the miner fee pays for
 * the transaction carrying it. Both are native, and **a token balance cannot
 * pay either** — which is the whole reason this figure is worth computing
 * before anything is signed rather than discovering it as a rejection.
 *
 * The miner half is an allowance, not a quote: the real figure depends on the
 * size of a transaction that does not exist yet.
 */
export const MINER_ALLOWANCE = 0.0001;

export const NATIVE_NEEDED = Number(CONVERSION_TRANSFER_FEE) + MINER_ALLOWANCE;

/** A basket with the fractional bit set. */
const FRACTIONAL = 1;

/**
 * Every live, funded basket on the chain.
 *
 * One `listcurrencies` — 485 KB and about a second against the public testnet
 * node, measured. That is a lot for one call and it is still the right trade:
 * there is no reverse index on chain. `getcurrency` answers "what does this
 * basket hold", and nothing answers "which baskets hold this", which is exactly
 * the question a conversion form has to answer first. `getcurrencyconverters`
 * would do it and is not a method this daemon has.
 *
 * Cached for the life of the window, which is one conversion.
 */
const basketCache = new Map();

export async function baskets(node) {
  const held = basketCache.get(node);
  if (held) return held;

  const rows = await rpc(node, 'listcurrencies', []);
  const found = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const definition = row?.currencydefinition;
    const state = row?.bestcurrencystate;
    if (!definition?.currencyid) return [];
    if (!(Number(definition.options) & FRACTIONAL)) return [];
    // A basket with no supply has not launched, or has refunded. Either way
    // there is nothing to convert through it.
    if (!(Number(state?.supply) > 0)) return [];

    // A reserve at zero is a market you cannot sell into.
    const legs = (state?.reservecurrencies ?? [])
      .filter((leg) => Number(leg?.reserves) > 0 && leg?.currencyid)
      .map((leg) => leg.currencyid);
    if (legs.length < 2) return [];

    return [{
      id: definition.currencyid,
      name: definition.fullyqualifiedname ?? definition.name ?? definition.currencyid,
      legs,
    }];
  });

  basketCache.set(node, found);
  return found;
}

/**
 * Which of the three conversions this is, from where the pool sits.
 *
 *     from IS the pool    spending the basket for one of its reserves   intoReserve
 *     into IS the pool    buying a share of the basket                  intoFractional
 *     neither             reserve to reserve, routed through it         reserveToReserve
 *
 * Null when both ends are the same currency, which is not a conversion.
 */
export function kindOf(from, into, poolId) {
  if (from === into) return null;
  if (from === poolId) return 'intoReserve';
  if (into === poolId) return 'intoFractional';
  return 'reserveToReserve';
}

/**
 * Every conversion with `anchor` on one side of it.
 *
 * The anchor is the currency the page named — the one whose page the reader
 * pressed a button on. Keeping it on one side of every route is what makes the
 * direction control mean "spend it or receive it" rather than turning this
 * window into a general exchange, and it keeps the table to a handful of rows
 * out of fifty-odd baskets.
 *
 * Both directions are emitted for every pair, so flipping the direction is a
 * lookup rather than a second derivation that could disagree with the first.
 */
export function routesAround(anchorId, pools) {
  const routes = [];
  const add = (from, into, pool) => {
    const kind = kindOf(from, into, pool.id);
    if (!kind) return;
    routes.push({ from, into, kind, via: kind === 'reserveToReserve' ? pool.id : null, pool });
  };

  for (const pool of pools) {
    if (pool.id === anchorId) {
      // The anchor is itself a basket: it trades against each of its reserves,
      // and `venuesOf`-style thinking misses this entirely because a basket is
      // never listed among its own legs.
      for (const leg of pool.legs) {
        add(anchorId, leg, pool);
        add(leg, anchorId, pool);
      }
      continue;
    }

    if (!pool.legs.includes(anchorId)) continue;

    // A basket is tradeable as itself, not only through its reserves.
    add(anchorId, pool.id, pool);
    add(pool.id, anchorId, pool);

    for (const leg of pool.legs) {
      if (leg === anchorId) continue;
      add(anchorId, leg, pool);
      add(leg, anchorId, pool);
    }
  }

  return routes;
}

/**
 * The other side of the trade, as a list to choose from.
 *
 * `spendAnchor` picks the direction: spending the anchor means the counter is
 * what arrives, receiving it means the counter is what is spent.
 *
 * What the reader holds comes first, largest first, because that is what they
 * can actually do right now. Everything else is still listed — a wallet holding
 * nothing should still show what the coin trades against, and an empty picker
 * would read as "this cannot be converted" when the truth is "not by you, yet".
 */
export function counters(anchorId, routes, held = new Map(), spendAnchor = true) {
  const seen = new Set();
  for (const route of routes) {
    const other = spendAnchor ? route.into : route.from;
    if (other === anchorId) continue;
    seen.add(other);
  }

  return [...seen].sort((a, b) => {
    // Only the spend side is weighed by balance: what you hold decides what you
    // can pay with, and says nothing about what is worth receiving.
    const av = spendAnchor ? 0 : (held.get(a) ?? 0);
    const bv = spendAnchor ? 0 : (held.get(b) ?? 0);
    return bv - av || a.localeCompare(b);
  });
}

/** Every pool that can settle exactly this conversion. */
export function routesFor(routes, from, into) {
  return routes.filter((route) => route.from === from && route.into === into);
}

/**
 * An amount the chain will accept.
 *
 * Money is eight decimal places. A float carries more — a balance, or a floor
 * derived from an estimate, routinely does — and the daemon refuses anything
 * longer with a flat `Invalid amount`, after the reader has typed everything.
 *
 * Truncates rather than rounds, in both directions on purpose: rounding a
 * balance up asks to spend more than exists, and rounding a floor up rejects a
 * fill that would have been accepted.
 */
export function toCoinString(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const [whole = '0', frac = ''] = n.toFixed(20).split('.');
  return `${whole}.${frac.slice(0, 8).padEnd(8, '0')}`;
}

/**
 * What one conversion would settle at, according to the node.
 *
 * Asked rather than computed. Verus prices a basket at `reserves / (supply ×
 * weight)`, so the curve could be integrated here for nothing — but conversions
 * clear in per-block batches at one aggregate price rather than walking that
 * curve per trade, and the two disagree. This is the same call the build will
 * be checked against, so it cannot disagree with what actually settles.
 *
 * Null when the node refuses. A pool that will not price a trade is worth
 * leaving blank; a zero would read as "free".
 */
export async function quote(node, { from, into, via, amount }) {
  const value = Number(toCoinString(amount));
  if (!(value > 0)) return null;

  const request = { currency: from, convertto: into, amount: value };
  // Present only for a reserve-to-reserve trade. The daemon refuses it on the
  // other two kinds rather than ignoring it.
  if (via) request.via = via;

  try {
    const result = await rpc(node, 'estimateconversion', [request]);
    const out = Number(result?.estimatedcurrencyout);
    return Number.isFinite(out) && out > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * The pool that pays best for this trade, at this size.
 *
 * Not the deepest. Depth decides where the crossover is, not who wins: a
 * shallower basket quoting better wins every size small enough that its curve
 * has not eaten the difference. So the winner is measured rather than guessed.
 *
 * Ids are sent, not names. Both resolve, and an id cannot be ambiguous between
 * two currencies that chose the same name.
 */
export async function bestRoute(node, candidates, amount) {
  if (candidates.length === 0) return null;

  const quoted = await Promise.all(
    candidates.map(async (route) => {
      const out = await quote(node, {
        from: route.from,
        into: route.into,
        via: route.via,
        amount,
      });
      return out === null ? null : { route, out };
    }),
  );

  return quoted.filter(Boolean).sort((a, b) => b.out - a.out)[0] ?? null;
}

/**
 * A route and an amount, as the params `verus_convert` already knows how to build.
 *
 * The whole point of this module: what comes out here goes into the existing
 * build path untouched, so the interactive form is a way of FILLING IN a
 * request rather than a second way of making one.
 *
 * Optional keys are omitted, never set to `undefined` — the DTO reader iterates
 * a present key regardless of its value, and `{tokenFunding: undefined}` once
 * cost a debugging session that ended at `Reflect.get called on non-object`.
 */
export function requestFor({ route, amount, quotedOut, slippage = SLIPPAGE }) {
  const value = Number(amount);
  // Checked before `toCoinString`, which maps anything unusable to '0' — and a
  // request carrying `amount: '0'` looks deliberate by the time it is read.
  if (!Number.isFinite(value) || value <= 0) return null;
  const coins = toCoinString(value);
  if (!(Number(coins) > 0)) return null;

  const request = {
    from: route.from,
    into: route.into,
    kind: route.kind,
    amount: coins,
  };
  if (route.via) request.via = route.via;

  const floor = Number.isFinite(Number(quotedOut)) && Number(quotedOut) > 0
    ? toCoinString(Number(quotedOut) * (1 - slippage))
    : '0';
  if (Number(floor) > 0) request.minExpected = floor;

  return request;
}
