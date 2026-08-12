// The route table, checked without a browser.
//
// # Why this file exists at all
//
// Every other test here drives a real Chrome against a real node, because the
// bugs that hurt were integration bugs. This one is different: `via` is the
// field that cannot be checked at runtime.
//
// A misplaced `via` throws while BUILDING, inside the approval window, after
// the reader has typed a passphrase. The page never sees it — the promise it is
// waiting on settles only when the reader then closes the window, and it
// settles as an ordinary rejection. There is no code, no log, and nothing to
// distinguish it from somebody changing their mind.
//
// So the invariant `via is present exactly when the kind is reserveToReserve`
// is held here instead, over every direction and every position a pool can take
// in a trade. The three rules were confirmed against the daemon first; these
// tests keep the derivation honest to them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIPPAGE,
  baskets,
  counters,
  kindOf,
  requestFor,
  routesAround,
  routesFor,
  toCoinString,
  transferFee,
} from '../src/lib/convert.js';

const COIN = 'iCoin';
const OTHER = 'iOther';
const THIRD = 'iThird';
const BASKET = 'iBasket';
const RIVAL = 'iRival';

const basket = { id: BASKET, name: 'BASKET', legs: [COIN, OTHER] };
const rival = { id: RIVAL, name: 'RIVAL', legs: [COIN, OTHER, THIRD] };

const routeFor = (routes, from, into) => {
  const found = routesFor(routes, from, into)[0];
  assert.ok(found, `expected a route ${from} -> ${into}`);
  return found;
};

/* ---- kind and via ------------------------------------------------------- */

test('the three kinds come from where the pool sits', () => {
  assert.equal(kindOf(BASKET, COIN, BASKET), 'intoReserve');
  assert.equal(kindOf(COIN, BASKET, BASKET), 'intoFractional');
  assert.equal(kindOf(COIN, OTHER, BASKET), 'reserveToReserve');
});

test('a currency converted into itself is not a conversion', () => {
  assert.equal(kindOf(COIN, COIN, BASKET), null);
});

test('via is present exactly when the kind is reserveToReserve', () => {
  // The whole reason this file exists. Held over every route the form can
  // possibly produce, in both directions, for an anchor that is a reserve and
  // for an anchor that is a basket.
  for (const anchor of [COIN, BASKET, OTHER]) {
    const routes = routesAround(anchor, [basket, rival]);
    assert.ok(routes.length > 0, `no routes around ${anchor}`);
    for (const route of routes) {
      assert.equal(
        route.via !== null,
        route.kind === 'reserveToReserve',
        `${route.from} -> ${route.into} (${route.kind}) must ${
          route.kind === 'reserveToReserve' ? 'carry' : 'omit'
        } via`,
      );
      if (route.via) assert.equal(route.via, route.pool.id, 'via must name the routing pool');
    }
  }
});

test('a reserve reaches another reserve through the basket', () => {
  const routes = routesAround(COIN, [basket]);
  const route = routeFor(routes, COIN, OTHER);
  assert.equal(route.kind, 'reserveToReserve');
  assert.equal(route.via, BASKET);
});

test('a reserve reaches the basket itself without a route', () => {
  const routes = routesAround(COIN, [basket]);
  assert.equal(routeFor(routes, COIN, BASKET).kind, 'intoFractional');
  assert.equal(routeFor(routes, COIN, BASKET).via, null);
  assert.equal(routeFor(routes, BASKET, COIN).kind, 'intoReserve');
  assert.equal(routeFor(routes, BASKET, COIN).via, null);
});

test('a basket trades against its own reserves, which no leg list reports', () => {
  // A basket is never among its own legs, so anything derived from "pools that
  // hold this currency" misses the whole of a basket's own market.
  const routes = routesAround(BASKET, [basket]);
  assert.equal(routeFor(routes, BASKET, COIN).kind, 'intoReserve');
  assert.equal(routeFor(routes, COIN, BASKET).kind, 'intoFractional');
  assert.equal(routeFor(routes, BASKET, OTHER).kind, 'intoReserve');
});

test('every route keeps the anchor on one side', () => {
  for (const route of routesAround(COIN, [basket, rival])) {
    assert.ok(route.from === COIN || route.into === COIN, `${route.from} -> ${route.into} has no anchor`);
  }
});

test('both directions exist for every pair', () => {
  const routes = routesAround(COIN, [basket, rival]);
  for (const route of routes) {
    assert.ok(
      routesFor(routes, route.into, route.from).length > 0,
      `no way back from ${route.into} to ${route.from}`,
    );
  }
});

test('a pool that does not touch the anchor contributes nothing', () => {
  const elsewhere = { id: 'iElse', name: 'ELSE', legs: [OTHER, THIRD] };
  assert.deepEqual(routesAround(COIN, [elsewhere]), []);
});

test('two baskets over the same pair are both offered', () => {
  const routes = routesAround(COIN, [basket, rival]);
  assert.deepEqual(
    routesFor(routes, COIN, OTHER).map((r) => r.pool.id).sort(),
    [BASKET, RIVAL],
  );
});

/* ---- counters ------------------------------------------------------------ */

test('counters are everything the anchor reaches, never the anchor', () => {
  const routes = routesAround(COIN, [basket, rival]);
  const found = counters(COIN, routes);
  assert.deepEqual(found.sort(), [BASKET, OTHER, RIVAL, THIRD]);
  assert.ok(!found.includes(COIN));
});

test('what you hold comes first when it is what you would spend', () => {
  const routes = routesAround(COIN, [basket, rival]);
  const held = new Map([[THIRD, 500], [OTHER, 10]]);
  // Receiving the anchor means the counter is what gets spent, so balances rank it.
  assert.deepEqual(counters(COIN, routes, held, false).slice(0, 2), [THIRD, OTHER]);
});

test('holdings do not reorder what you would receive', () => {
  const routes = routesAround(COIN, [basket, rival]);
  const held = new Map([[THIRD, 500]]);
  // Spending the anchor: the counter is what arrives, and owning some of it
  // already says nothing about whether it is worth receiving.
  assert.deepEqual(counters(COIN, routes, held, true), counters(COIN, routes, new Map(), true));
});

/* ---- amounts and the floor ----------------------------------------------- */

test('amounts truncate to eight places and never round up', () => {
  assert.equal(toCoinString('1.123456789'), '1.12345678');
  assert.equal(toCoinString(0.0015232988560025592), '0.00152329');
  assert.equal(toCoinString(3), '3.00000000');
});

test('an unusable amount is refused rather than sent as zero', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  for (const amount of ['', 'abc', '0', '-1', ' ', Number.NaN, Number.POSITIVE_INFINITY, 0]) {
    assert.equal(
      requestFor({ route, amount }),
      null,
      `expected ${JSON.stringify(String(amount))} to be refused`,
    );
  }
});

test('an amount below a satoshi is refused', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  assert.equal(requestFor({ route, amount: 0.000000001 }), null);
});

test('a reserve-to-reserve request carries its route', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  const request = requestFor({ route, amount: '1', quotedOut: 100 });
  assert.deepEqual(request, {
    from: COIN,
    into: OTHER,
    kind: 'reserveToReserve',
    via: BASKET,
    amount: '1.00000000',
    minExpected: toCoinString(100 * (1 - SLIPPAGE)),
  });
});

test('the other kinds have no via KEY, not a via of undefined', () => {
  // `{via: undefined}` and a missing key are the same to JSON and not the same
  // to the DTO reader, which iterates a key that is merely present.
  const routes = routesAround(COIN, [basket]);
  for (const [from, into] of [[COIN, BASKET], [BASKET, COIN]]) {
    const request = requestFor({ route: routeFor(routes, from, into), amount: '1' });
    assert.ok(!('via' in request), `via must be absent, got ${JSON.stringify(request)}`);
  }
});

test('no quote means no floor, and the key is absent', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  for (const quotedOut of [null, undefined, 0, -1, Number.NaN]) {
    const request = requestFor({ route, amount: '1', quotedOut });
    assert.ok(!('minExpected' in request), `expected no floor for ${String(quotedOut)}`);
  }
});

test('a floor never rounds up into a fill that would be rejected', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  const request = requestFor({ route, amount: '1', quotedOut: 1.000000009, slippage: 0 });
  assert.equal(request.minExpected, '1.00000000');
});

test('everything the wallet builds from is an eight-place string', () => {
  const route = routeFor(routesAround(COIN, [basket]), COIN, OTHER);
  const request = requestFor({ route, amount: 7, quotedOut: 3 });
  assert.match(request.amount, /^\d+\.\d{8}$/);
  assert.match(request.minExpected, /^\d+\.\d{8}$/);
});

/* ---- reading the chain's listing ------------------------------------------ */

/** `listcurrencies`, without a node. Each call gets its own url — the cache is real. */
function withListing(rows, run) {
  const node = `https://fixture.invalid/${Math.random()}`;
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ result: rows }));
  try {
    return run(node);
  } finally {
    globalThis.fetch = real;
  }
}

const listing = (definition, state) => ({ currencydefinition: definition, bestcurrencystate: state });
const funded = (...ids) => ({
  supply: 1000,
  reservecurrencies: ids.map((id) => ({ currencyid: id, reserves: 100 })),
});

test('only live funded baskets are routes', async () => {
  const rows = [
    listing({ currencyid: BASKET, name: 'BASKET', options: 1 }, funded(COIN, OTHER)),
    // Not fractional: a plain token is not a market.
    listing({ currencyid: 'iToken', name: 'TOKEN', options: 32 }, funded(COIN, OTHER)),
    // No supply: defined, but not launched or refunded.
    listing({ currencyid: 'iUnlaunched', name: 'SOON', options: 1 }, { supply: 0, reservecurrencies: [] }),
    // One funded leg: a reserve at zero is a market you cannot sell into.
    listing({ currencyid: 'iDry', name: 'DRY', options: 1 }, {
      supply: 1000,
      reservecurrencies: [{ currencyid: COIN, reserves: 100 }, { currencyid: OTHER, reserves: 0 }],
    }),
  ];

  const found = await withListing(rows, (node) => baskets(node));
  assert.deepEqual(found.map((b) => b.id), [BASKET]);
  assert.deepEqual(found[0].legs, [COIN, OTHER]);
});

test('a basket is named by its fully qualified name when it has one', async () => {
  const rows = [
    listing({ currencyid: BASKET, name: 'BASKET', fullyqualifiedname: 'BASKET.vETH', options: 1 }, funded(COIN, OTHER)),
  ];
  const found = await withListing(rows, (node) => baskets(node));
  assert.equal(found[0].name, 'BASKET.vETH');
});

test('a listing that is not a list is not an error', async () => {
  // A node answering something unexpected should leave the form empty and
  // honest, not throw inside a window the reader cannot recover.
  const found = await withListing(null, (node) => baskets(node));
  assert.deepEqual(found, []);
});

/* ---- the transfer fee, which is not one number ---------------------------- */

/**
 * Ten satoshis, and every conversion this wallet built was rejected for them.
 *
 * The figures come from the SDK's daemon-matching tests, which build each kind
 * and assert the bytes against what the daemon itself produces:
 * `a_reserve_into_a_fractional_matches_the_daemon`,
 * `a_fractional_into_a_reserve_matches_the_daemon` and
 * `a_reserve_to_reserve_conversion_matches_the_daemon` all pass 20_010, while
 * `a_preconvert_matches_the_daemon` and `a_burn_matches_the_daemon` pass 20_000.
 *
 * Paying the preconvert figure for a conversion is refused with
 * `bad-txns-failed-precheck`, which names neither the fee nor the shortfall —
 * so nothing at runtime will ever tell you this is wrong again.
 */
test('a conversion is charged more than a preconvert', () => {
  const sats = (coins) => Math.round(Number(coins) * 1e8);

  for (const kind of ['intoFractional', 'intoReserve', 'reserveToReserve']) {
    assert.equal(sats(transferFee(kind)), 20_010, `${kind} must pay what the daemon charges`);
  }
  assert.equal(sats(transferFee('preconvert')), 20_000);
});

test('the fee is a coin string the chain will parse', () => {
  for (const kind of ['intoFractional', 'intoReserve', 'reserveToReserve', 'preconvert']) {
    assert.match(transferFee(kind), /^0\.\d{1,8}$/, kind);
  }
});
