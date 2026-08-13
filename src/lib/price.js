// What a balance is worth, priced by Verus rather than by anyone else.
//
// # Why there is no price API in here
//
// The obvious way to put a recognisable number under a balance is to ask a
// price aggregator. That would mean a second host in `host_permissions`, an
// install-time warning naming it, and a request every time the popup opens that
// tells a third party someone just looked at their wallet — to answer a question
// the chain can already answer about itself.
//
// Verus prices its own currencies. `bridge.vETH` is a basket holding the native
// coin and DAI.vETH among its reserves, and its currency state carries what each
// reserve is worth. One read of a node this wallet already talks to prices
// everything in that basket at once, and nothing leaves the two hosts the
// extension has always used.
//
// # Why DAI, and why the same on both chains
//
// DAI.vETH is the stable reserve in the basket, so it is the unit anything in
// there can be quoted against. Both chains carry the same basket with the same
// reserve — testnet included, where a `USD` currency does exist but is mintable
// by its issuer, has a single reserve, and cannot be converted to from VRSCTEST
// at all. A single-reserve basket is a fixed price by construction, so quoting
// against it would print a number that is not a market price. Measured, not
// assumed: `estimateconversion VRSCTEST → vUSDC` answers
// `Source currency cannot be converted to destination`.
//
// # Why a mid price and not a quote
//
// `estimateconversion` says what you would receive after fees and slippage,
// which is the right answer to "what would I get for this" and the wrong one to
// "what is this worth". It is also one call per asset. The reserve state is one
// call for the whole basket, and the two agree to within the fee — 11.7634 /
// 18.4687 = 0.6370 against an actual quote of 0.6366.

import { rpc } from './rpc.js';

/** The basket that does the pricing. Same name on both chains. */
const BASKET = 'bridge.veth';

/** The reserve everything is quoted against. */
const UNIT = 'DAI.vETH';

/** How it is written on screen. The `.vETH` says which bridge, not which asset. */
export const UNIT_LABEL = 'DAI';
export const UNIT_FULL = UNIT;

/**
 * Prices for everything the basket can price, keyed by currency id.
 *
 * @returns {Promise<Map<string, number>>} DAI per unit of that currency. Empty
 *   when the basket cannot be read — never a partial guess, and never a throw:
 *   a missing price hides a line, while a failure here must not cost anybody
 *   their balance.
 */
export async function priceBook(node) {
  let basket;
  let unit;
  try {
    [basket, unit] = await Promise.all([
      rpc(node, 'getcurrency', [BASKET]),
      rpc(node, 'getcurrency', [UNIT]),
    ]);
  } catch {
    return new Map();
  }

  const reserves = basket?.bestcurrencystate?.reservecurrencies;
  const unitId = unit?.currencyid;
  if (!Array.isArray(reserves) || !unitId) return new Map();

  // `priceinreserve` is what ONE basket unit is worth in that reserve. So a
  // reserve's price in DAI is the ratio of the two — 1 basket buys 18.4687 VRSC
  // and 11.7634 DAI, therefore 1 VRSC is 11.7634/18.4687 DAI.
  const perUnit = Number(reserves.find((r) => r?.currencyid === unitId)?.priceinreserve);
  if (!Number.isFinite(perUnit) || perUnit <= 0) return new Map();

  const prices = new Map();
  for (const reserve of reserves) {
    const price = Number(reserve?.priceinreserve);
    if (!reserve?.currencyid || !Number.isFinite(price) || price <= 0) continue;
    prices.set(reserve.currencyid, perUnit / price);
  }

  // The basket is not one of its own reserves, and it is a thing people hold:
  // one of it is worth exactly what it holds in DAI.
  if (basket.currencyid) prices.set(basket.currencyid, perUnit);

  return prices;
}
