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

/**
 * Split an address into scannable groups.
 *
 * Nobody verifies thirty-four characters read left to right, and presenting
 * them as one run invites exactly that. People check the ends — which is the
 * whole basis of address-substitution malware, where the middle is what
 * changes. Grouping gives the eye somewhere to rest and makes a comparison
 * against a source possible at all.
 *
 * Returned as an array so the caller decides which groups to emphasise, and so
 * the raw address is never reconstructed from display text.
 */
export function chunk(address, size = 6) {
  const s = String(address ?? '');
  const groups = [];
  for (let i = 0; i < s.length; i += size) groups.push(s.slice(i, i + size));
  return groups;
}

/**
 * How long ago, in the shortest form that is still true.
 *
 * Activity is scanned, not read: "2h" answers "did my payment go through" at a
 * glance, where a timestamp makes the reader do arithmetic.
 */
export function ago(seconds) {
  const then = Number(seconds);
  if (!Number.isFinite(then) || then <= 0) return '';
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - then));
  if (delta < 60) return 'now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 2_592_000) return `${Math.floor(delta / 86_400)}d`;
  return `${Math.floor(delta / 2_592_000)}mo`;
}
