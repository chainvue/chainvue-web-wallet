// Display formatting.
//
// # The unit trap this file exists to avoid
//
// `getaddressbalance` reports two things in two different units:
//
//   balance:         78699910000                       satoshis
//   currencybalance: { "iFhna…": 4.76077049, … }        COINS, as floats
//
// So the SDK's `formatCoins`, which takes a satoshi string, is right for the
// first and catastrophically wrong for the second — it would render 4.76
// dudecoin as 0.00000004. Anything out of `currencybalance` goes through
// `coins()` here instead, which formats a number that is already in coins.

/** Format an amount that is already denominated in coins. */
export function coins(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const [whole, frac] = n.toFixed(8).split('.');
  return `${Number(whole).toLocaleString('en-US')}.${frac}`;
}

/** Shorter, for a list column: enough digits to be useful, few enough to scan. */
export function coinsShort(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  const [whole, frac] = n.toFixed(decimals).split('.');
  const trimmed = frac ? frac.replace(/0+$/, '') : '';
  return trimmed
    ? `${Number(whole).toLocaleString('en-US')}.${trimmed}`
    : Number(whole).toLocaleString('en-US');
}

export function elide(text, head = 8, tail = 6) {
  const s = String(text ?? '');
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}
