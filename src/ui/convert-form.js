// Deciding a conversion, in the window that will sign it.
//
// The page names one currency — the anchor, whatever the reader was looking at
// — and everything else is chosen here: which side of the trade the anchor is
// on, what the other side is, and how much. The reader's balances are on screen
// while they choose, which is the whole reason this moved out of the page: a
// website cannot see them, so it can only offer trades and hope.
//
// What comes out is an ordinary `verus_convert` params object. It goes into the
// existing build path untouched — this is a way of FILLING IN a request, not a
// second way of making one.

import { el, mount, panel, row } from '../lib/dom.js';
import { coinsShort } from '../lib/fmt.js';
import { currencyBalances, currencyNames, rpc } from '../lib/rpc.js';
import { defiHalt, haltMessage } from '../lib/halt.js';
import {
  NATIVE_NEEDED,
  QUOTE_DEBOUNCE_MS,
  SLIPPAGE,
  baskets,
  bestRoute,
  counters,
  requestFor,
  routesAround,
  routesFor,
  toCoinString,
} from '../lib/convert.js';

/**
 * @param {object} options
 * @param {{label: string, node: string, native: string}} options.net
 * @param {string} options.address the signing key's address — known without the passphrase
 * @param {object} options.params whatever the page did supply, as starting values
 * @param {(ready: boolean) => void} options.onValidity
 * @returns {{node: HTMLElement, read: () => object, ready: Promise<void>}}
 */
export function convertForm({ net, address, params, onValidity = () => {} }) {
  const state = {
    anchor: null,
    anchorName: String(params.into ?? params.from ?? ''),
    routes: [],
    names: new Map(),
    held: new Map(),
    /** True when the anchor is what gets spent. */
    spending: Boolean(params.from) && !params.into,
    counter: null,
    best: null,
    native: null,
    halt: null,
    /** Both assumed until a reading says otherwise, so a failed read blocks nothing. */
    canPayFees: true,
    canConvert: true,
  };

  const direction = el('select', { 'aria-label': 'direction', onchange: onDirection });
  const counter = el('select', { 'aria-label': 'the other currency', onchange: onCounter });
  // Named by the label rather than an `aria-label`: the visible text says which
  // currency the figure is in and what you hold of it, and an `aria-label` would
  // quietly replace all of that with the word "amount".
  const amount = el('input', {
    id: 'convert-amount',
    type: 'text',
    inputmode: 'decimal',
    placeholder: '0.0',
    oninput: onAmount,
  });
  const spendLabel = el('label', { for: 'convert-amount' }, 'amount');
  if (params.amount) amount.value = String(params.amount);

  /** Spending more than the address holds. A warning, never a refusal — see below. */
  const shortfall = el('div', { class: 'warn small' });

  /** Whether there is native coin to pay the fees with. A refusal — see `fees`. */
  const fees = el('div', { class: 'danger small' });

  /** Whether the chain is taking conversions at all. A refusal — see `reportHalt`. */
  const halted = el('div', { class: 'danger small' });

  // Its own class, not `status`: the approval window has a `.status` line of its
  // own, and two of them under one selector is a trap for every test that reads
  // "what did the window settle on".
  const estimate = el('div', { class: 'quote small', role: 'status' }, 'reading the chain…');
  const body = el('div', {}, [
    halted,
    fees,
    el('label', {}, 'direction'),
    direction,
    el('label', {}, 'the other currency'),
    counter,
    spendLabel,
    amount,
    shortfall,
    estimate,
  ]);
  body.hidden = true;

  const loading = el('p', { class: 'muted small' }, 'reading what you hold and what this trades against…');
  const node = panel('convert', [loading, body]);

  /* ---- loading ---------------------------------------------------------- */

  const ready = (async () => {
    const named = String(params.into ?? params.from ?? '').trim();
    if (!named) throw new Error('the page did not say what to convert');

    // Resolved rather than trusted: the page sends a name, and everything shown
    // from here on is what the chain says that name is.
    const definition = await rpc(net.node, 'getcurrency', [named]);
    if (!definition?.currencyid) throw new Error(`no currency called "${named}" on ${net.label}`);
    state.anchor = definition.currencyid;
    state.anchorName = definition.fullyqualifiedname ?? definition.name ?? named;

    // Balances are a nicety and the routes are not, so a node that will not
    // answer about the address must not take the form down with it.
    const [pools, held, nativeDef, halt] = await Promise.all([
      baskets(net.node),
      currencyBalances(net.node, address).catch(() => []),
      rpc(net.node, 'getcurrency', [net.native]).catch(() => null),
      defiHalt(net),
    ]);
    state.held = new Map(held.map((entry) => [entry.id, entry.amount]));
    state.native = nativeDef?.currencyid ?? null;
    state.halt = halt;
    reportHalt();
    reportFees();

    state.routes = routesAround(state.anchor, pools);
    if (state.routes.length === 0) {
      throw new Error(`no live basket trades ${state.anchorName}, so there is nothing to convert it against`);
    }

    const ids = new Set([state.anchor]);
    for (const route of state.routes) {
      ids.add(route.from);
      ids.add(route.into);
    }
    state.names = await currencyNames(net.node, [...ids]);

    // A `from` the page named only counts if it is really one of the routes.
    if (params.from) {
      const wanted = [...ids].find((id) => nameOf(id) === String(params.from) || id === String(params.from));
      if (wanted && wanted !== state.anchor) {
        state.spending = false;
        state.counter = wanted;
      }
    }

    fillDirection();
    fillCounters();
    loading.remove();
    body.hidden = false;
    revalidate();
    quoteSoon();
  })();

  ready.catch((error) => {
    mount(node, el('div', { class: 'panel-title' }, 'convert'), el('p', { class: 'danger small' }, error?.message ?? String(error)));
    onValidity(false);
  });

  /* ---- the controls ------------------------------------------------------ */

  const nameOf = (id) => state.names.get(id) ?? id;

  /**
   * Whether the chain is taking conversions at all, said before anything else.
   *
   * Nothing else on screen can tell. The routes are real, the balances are
   * real, and the estimate is a real answer from the node — a halted chain
   * quotes exactly like a running one. Only the switch says otherwise.
   *
   * A reading that could not be taken (`null`) is left alone rather than
   * treated as clear: a chain nobody could ask might be halted, and letting
   * missing data read as working is the failure this exists to prevent. The
   * build asks again and refuses there.
   */
  function reportHalt() {
    const message = haltMessage(net, state.halt);
    if (!message) {
      mount(halted, null);
      return;
    }
    state.canConvert = !state.halt?.halted;
    mount(halted, state.halt?.halted ? message : el('span', { class: 'warn' }, message));
  }

  /**
   * Whether the fees can be paid at all, said once and up front.
   *
   * A conversion costs native coin twice over — the transfer fee inside the
   * reserve transfer, and the miner fee for the transaction carrying it — and
   * a wallet holding only tokens can pay neither. Without this the wallet
   * builds a transaction that cannot be accepted, takes a passphrase for it,
   * and the daemon answers `bad-txns-failed-precheck`: a message that names
   * neither the fee nor the currency, after the one moment somebody was
   * willing to sign.
   *
   * Exactly zero is a refusal, because zero is not a rounding artefact and no
   * conversion can come out of it. Merely *low* is a warning: the miner half is
   * an allowance rather than a quote, and refusing on an estimate would refuse
   * transactions that would have gone through.
   */
  function reportFees() {
    const balance = state.native ? (state.held.get(state.native) ?? 0) : null;
    state.canPayFees = balance === null || balance > 0;

    if (balance === null) {
      // The node would not say what the native currency is. Say nothing rather
      // than refuse on a reading that was never taken.
      mount(fees, null);
      return;
    }
    if (balance <= 0) {
      mount(
        fees,
        `this address holds no ${net.native} — a conversion pays its fee in ${net.native}, ` +
          `so nothing can be converted until it has some`,
      );
      return;
    }
    if (balance < NATIVE_NEEDED) {
      mount(
        fees,
        el(
          'span',
          { class: 'warn' },
          `only ${coinsShort(balance)} ${net.native} for fees — a conversion needs about ` +
            `${coinsShort(NATIVE_NEEDED)} for the transfer and the miner`,
        ),
      );
      return;
    }
    mount(fees, null);
  }

  function fillDirection() {
    mount(
      direction,
      el('option', { value: 'spend', selected: state.spending }, `spend ${state.anchorName}`),
      el('option', { value: 'receive', selected: !state.spending }, `receive ${state.anchorName}`),
    );
  }

  function fillCounters() {
    const options = counters(state.anchor, state.routes, state.held, state.spending);
    // Keep the reader's choice across a direction flip when it still exists.
    if (!options.includes(state.counter)) state.counter = options[0] ?? null;

    mount(
      counter,
      ...options.map((id) => {
        const balance = state.held.get(id);
        // What you hold is shown against every option, not only the spendable
        // side: it is the fact most worth having on screen and it costs a line.
        const suffix = balance ? `  ·  you hold ${coinsShort(balance)}` : '';
        return el('option', { value: id, selected: id === state.counter }, `${nameOf(id)}${suffix}`);
      }),
    );

    const spendId = state.spending ? state.anchor : state.counter;
    const balance = spendId ? state.held.get(spendId) : null;
    mount(
      spendLabel,
      document.createTextNode(`amount in ${spendId ? nameOf(spendId) : '—'}`),
      balance
        ? el('span', { class: 'muted' }, `  ·  you hold ${coinsShort(balance)}`)
        : el('span', { class: 'warn' }, '  ·  you hold none of this'),
    );
  }

  function onDirection(event) {
    state.spending = event.target.value === 'spend';
    fillCounters();
    revalidate();
    quoteSoon();
  }

  function onCounter(event) {
    state.counter = event.target.value;
    fillCounters();
    revalidate();
    quoteSoon();
  }

  function onAmount() {
    revalidate();
    quoteSoon();
  }

  /* ---- quoting ----------------------------------------------------------- */

  /** The current pair, in the order it will be converted. */
  function pair() {
    if (!state.anchor || !state.counter) return null;
    return state.spending
      ? { from: state.anchor, into: state.counter }
      : { from: state.counter, into: state.anchor };
  }

  function candidates() {
    const ends = pair();
    return ends ? routesFor(state.routes, ends.from, ends.into) : [];
  }

  let timer = null;
  let ticket = 0;

  function quoteSoon() {
    clearTimeout(timer);
    state.best = null;
    const value = Number(toCoinString(amount.value));
    if (!(value > 0)) {
      mount(estimate, el('span', { class: 'muted' }, 'enter an amount'));
      return;
    }
    mount(estimate, el('span', { class: 'muted' }, 'estimating…'));
    // Debounced: a keystroke is not a question, and each one asks the node once
    // per pool that could settle the trade.
    timer = setTimeout(() => void runQuote(value), QUOTE_DEBOUNCE_MS);
  }

  async function runQuote(value) {
    const mine = ++ticket;
    const options = candidates();
    if (options.length === 0) {
      mount(estimate, el('span', { class: 'warn' }, 'no basket routes this pair'));
      revalidate();
      return;
    }

    const best = await bestRoute(net.node, options, value);
    // A slower earlier answer must not land on top of a later one.
    if (mine !== ticket) return;

    state.best = best;
    if (!best) {
      mount(
        estimate,
        el('span', { class: 'warn' }, 'the node would not price this'),
        el('div', { class: 'muted small' }, 'It can still be built, but without a floor on what comes back.'),
      );
      revalidate();
      return;
    }

    const ends = pair();
    const floor = toCoinString(best.out * (1 - SLIPPAGE));
    mount(
      estimate,
      row('estimated', `${coinsShort(best.out)} ${nameOf(ends.into)}`),
      row('through', best.route.pool.name),
      row('at least', `${coinsShort(Number(floor))} ${nameOf(ends.into)}`),
      el(
        'div',
        { class: 'muted small' },
        'An estimate. Conversions settle at the block boundary, together, at one price — so what lands can differ.',
      ),
    );
    revalidate();
  }

  /* ---- what the build gets ------------------------------------------------ */

  function chosen() {
    return state.best?.route ?? candidates()[0] ?? null;
  }

  function revalidate() {
    const value = Number(toCoinString(amount.value));
    const spendId = state.spending ? state.anchor : state.counter;
    const balance = spendId ? (state.held.get(spendId) ?? 0) : 0;

    // Said early, and never enforced. `currencybalance` is one node's snapshot,
    // the miner fee comes out of the native coin on top of this, and a token
    // held by an identity does not appear here at all — so a form that refused
    // on it would refuse trades that would have gone through. The build says
    // "insufficient funds" plainly enough when it really is.
    mount(
      shortfall,
      value > 0 && value > balance
        ? `more than this address holds — ${balance > 0 ? `${coinsShort(balance)} available` : 'it holds none of this'}`
        : null,
    );

    onValidity(state.canConvert && state.canPayFees && Boolean(chosen()) && value > 0);
  }

  function read() {
    if (!state.canConvert) {
      throw new Error(`conversions are halted on ${net.label} — the chain would refuse this`);
    }
    if (!state.canPayFees) throw new Error(`this address has no ${net.native} to pay the fee with`);
    const route = chosen();
    if (!route) throw new Error('no basket routes this pair');
    const request = requestFor({
      route,
      amount: amount.value,
      quotedOut: state.best?.out ?? null,
    });
    if (!request) throw new Error('that is not an amount this chain can spend');
    return request;
  }

  return { node, read, ready };
}
