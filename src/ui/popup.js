// Key management, balances and sending. No page can reach any of this.
//
// # Why this is a set of views and not one long column
//
// The popup used to render everything it could do, stacked: keys, a send form,
// create-key, import-key. Chrome caps a toolbar popup at 600px, so the more the
// wallet learned to do the more of it fell below the fold — and the things a
// person opens a wallet for (what do I have, send, receive) sat at the same
// visual weight as one-time setup.
//
// So there are four views and one question each. `home` answers "what do I
// have"; the rest are reached deliberately and can be as tall as they need to
// be. Setup and anything destructive lives in `keys`, off the front page.

import init, { Key } from '../vendor/verus-wasm/verus_wasm.js';
import { el, mount, panel, foldout, address as addressEl } from '../lib/dom.js';
import {
  NETWORKS,
  currentNetwork,
  setNetwork,
  currencyBalances,
  currencyNames,
  controlledIdentities,
  recentActivity,
  counterparty,
  applyChain,
} from '../lib/rpc.js';
import { coinsShort, elide, ago, value as valueOf } from '../lib/fmt.js';
import { list, add, remove, seal, open as openVault } from '../lib/vault.js';
import { list as pendingList, forget as forgetPending } from '../lib/pending.js';
import { list as recentRecipients, clear as clearRecipients } from '../lib/recipients.js';
import { SEND_PATH, PORT } from '../lib/protocol.js';
import { parseDestination } from '../lib/address.js';
import { qrCanvas } from '../lib/qr.js';
import { priceBook, UNIT_LABEL, UNIT_FULL } from '../lib/price.js';

const root = document.getElementById('root');

// Before anything is awaited, so the window never paints the wrong chain's
// colours. Corrected from storage a moment later — see `applyChain`.
applyChain();

/** Which view, and which key it is about. Reset to home on every data change. */
let view = { name: 'home', key: null };

function go(name, key = view.key) {
  view = { name, key };
  render();
}

async function boot() {
  await init();
  await render();
}

async function render() {
  const net = await currentNetwork();
  const keys = await list();

  // One attribute, and the whole stylesheet knows which chain this is. This is
  // the authoritative stamp; the one at the top of the file is the same value
  // read from a synchronous cache so the first paint is not wrong.
  applyChain(net.label);

  if (keys.length === 0) {
    view = { name: 'home', key: null };
    // Claims in progress are shown here too. A commitment can outlive the key
    // that made it — the record is all that is left of a fee that is already
    // spent — and hiding it behind "you have no keys" would make the one screen
    // that can clear it unreachable.
    const pending = await pendingList(net.label);
    mount(root, ...chrome_(net, firstRun(net, pending)));
    return focusFirst();
  }

  const active = keys.find((k) => k.label === view.key) ?? keys[0];
  const body =
    view.name === 'send'
      ? sendView(keys, active, net)
      : view.name === 'receive'
        ? receiveView(active, net)
        : view.name === 'keys'
          ? keysView(keys, active, net)
          : await homeView(keys, active, net);

  mount(root, ...chrome_(net, body));
  return focusFirst();
}

/**
 * What wraps every view: the chain rail, when there is one to show.
 *
 * Named with a trailing underscore because `chrome` is the extension API and
 * shadowing it inside this module would be a memorable afternoon.
 */
function chrome_(net, body) {
  return [
    // Only on a real-money chain. A banner that is always there is furniture,
    // and furniture is not read.
    net.real ? el('div', { class: 'chain-rail', role: 'note' }, 'Mainnet · real funds') : null,
    ...body,
  ].filter(Boolean);
}

/**
 * Put the focus somewhere sensible after a navigation.
 *
 * `mount` replaces the whole document, which drops focus onto `<body>` — so a
 * keyboard user tabbed from the top of the window again after every single view
 * change. The first control in the new view is where they were going anyway.
 */
function focusFirst() {
  const first = root.querySelector('input:not([type=hidden]), select, button, a[href]');
  // `preventScroll` because the popup is scrollable once a wallet has a few
  // currencies, and focusing the top control must not yank the view.
  first?.focus({ preventScroll: true });
}

// --- chrome -----------------------------------------------------------------

function topBar(net, { back = null, title = null, plain = false } = {}) {
  const left = back
    ? el('button', { class: 'chip', onclick: () => go(back) }, `← ${title ?? ''}`.trim())
    : el('span', { class: 'bar-mark' }, '▚ CHAINVUE');

  // The network is a control, not a heading: switching chain is rare, and it
  // was occupying the top of the screen with a full-width labelled select.
  const picker = el(
    'select',
    {
      class: 'chip',
      'aria-label': 'network',
      onchange: async (event) => {
        const chosen = NETWORKS[event.target.value];
        // Asked in one direction only. Going to mainnet turns every mistake
        // from free into irreversible; coming back does nothing at all — and a
        // prompt that appears both ways is a prompt people learn to dismiss
        // without reading, which is worse than no prompt.
        if (chosen?.real && !net.real) {
          const agreed = confirm(
            'Switch to mainnet?\n\nTransactions on this chain spend real VRSC and cannot be undone. ' +
              'This wallet has not been audited.',
          );
          if (!agreed) {
            event.target.value = net.label;
            return;
          }
        }
        await setNetwork(event.target.value);
        await render();
      },
    },
    Object.keys(NETWORKS).map((label) => el('option', { value: label, selected: label === net.label }, label)),
  );

  return el('div', { class: 'bar' }, plain ? [left, picker] : [left, picker]);
}

/**
 * The account row, and the one thing it was missing.
 *
 * `view.key` was only ever assigned when a key was created, when one was
 * imported, or defaulted to the key already showing — so the active account was
 * whichever key you added most recently, permanently, and a second key was
 * stored and then unreachable. The keys screen offered exactly one verb for it:
 * remove.
 *
 * The row itself is unchanged. What is added is that the name is a button.
 *
 * Balances in the list are fetched when it opens rather than on every render:
 * it is one read per key, and it is only worth paying for at the moment somebody
 * is choosing between them — which is also the moment the number is the whole
 * point of showing.
 */
function accountRow(key, net, { action = true, keys = null } = {}) {
  const copy = el(
    'button',
    {
      class: 'chip',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(key.address);
          copy.textContent = 'Copied';
          setTimeout(() => {
            copy.textContent = 'Copy';
          }, 1200);
        } catch {
          copy.textContent = 'Press ⌘C';
        }
      },
    },
    'Copy',
  );

  // Only where there is something to switch between. On Receive, which is a
  // detail view of the account you are already on, the name stays a name.
  const switchable = Array.isArray(keys) && keys.length > 1;
  const sheet = el('div', {});

  const name = switchable
    ? el(
        'button',
        {
          class: 'acct-pick',
          'aria-expanded': 'false',
          'aria-label': `Account: ${key.label}. Change account`,
          onclick: () => toggleAccounts(name, sheet, keys, key, net),
        },
        [key.label, el('span', { class: 'caret' }, '▾')],
      )
    : el('div', { class: 'acct-name' }, key.label);

  return el('div', {}, [
    el('div', { class: 'acct' }, [
      el('div', { class: 'avatar' }),
      el('div', { class: 'acct-id' }, [
        name,
        el('div', { class: 'acct-addr' }, [addressEl(key.address, { short: true })]),
      ]),
      action ? copy : null,
    ]),
    sheet,
  ]);
}

function toggleAccounts(button, sheet, keys, active, net) {
  if (button.getAttribute('aria-expanded') === 'true') {
    button.setAttribute('aria-expanded', 'false');
    mount(sheet);
    return;
  }
  button.setAttribute('aria-expanded', 'true');

  const rows = keys.map((k) => {
    // Every row, including the one already shown. A list of accounts exists to
    // be compared, and a row reading "shown" where the others carry numbers is
    // the one row you cannot compare anything against.
    const amount = el('span', { class: 'sheet-amount' }, '…');
    loadAccountAmount(net, k.address, amount);
    return el(
      'button',
      {
        class: 'sheet-row',
        'aria-current': k.label === active.label ? 'true' : 'false',
        onclick: () => go('home', k.label),
      },
      [
        el('span', { class: 'sheet-tick' }, k.label === active.label ? '✓' : ''),
        el('span', { class: 'sheet-id' }, [
          el('span', { class: 'sheet-name' }, k.label),
          el('span', { class: 'acct-addr' }, [addressEl(k.address, { short: true })]),
        ]),
        amount,
      ],
    );
  });

  mount(
    sheet,
    el('div', { class: 'sheet' }, [
      ...rows,
      el('button', { class: 'sheet-row sheet-add', onclick: () => go('keys', active.label) }, '+ Add or import a key'),
    ]),
  );
  sheet.querySelector('.sheet-row')?.focus({ preventScroll: true });
}

/** One account's native balance, for the switcher. Best effort; never blocks. */
async function loadAccountAmount(net, address, node) {
  try {
    const held = await currencyBalances(net.node, address);
    const names = held.length ? await currencyNames(net.node, held.map((h) => h.id)) : new Map();
    const native = held.find((h) => (names.get(h.id) ?? h.id) === net.native);
    mount(node, coinsShort(native ? native.amount : 0), el('small', {}, net.native));
  } catch {
    mount(node, el('small', {}, 'unavailable'));
  }
}

// --- waiting ----------------------------------------------------------------

/**
 * Placeholders shaped like the thing that is coming.
 *
 * Not decoration. Chrome sizes a toolbar popup to its content and the window is
 * already on screen while balances are still being fetched, so an empty
 * container that later fills with rows moves everything below it — including
 * Send and Receive — at the moment somebody is reaching for them. Holding the
 * final height from the first paint is what stops that.
 *
 * Each placeholder therefore wears the SAME class as the row it stands in for,
 * and only its contents are blanked. Reserving a guessed height instead is how
 * this kind of thing ends up almost right: the geometry then lives in two places
 * and drifts the first time a row gains a line.
 *
 * Three of each, because three is the common case — so the common case does not
 * move at all.
 */
const WAITING_ROWS = 3;

function bar(width, height) {
  return el('span', { class: 'skel', style: `width:${width};height:${height}px` });
}

function holdingSkeletons() {
  return Array.from({ length: WAITING_ROWS }, (_unused, i) =>
    el('div', { class: 'hold-row' }, [
      el('span', { class: 'hold-dot skel' }),
      bar(`${46 - i * 8}%`, 11),
      // Two bars, because a holding row is two lines: the amount and what it is
      // worth. One would reserve half the height and hand back the shift this
      // whole mechanism exists to remove.
      el('span', { class: 'hold-amount' }, [bar('66px', 12), bar('48px', 9)]),
    ]),
  );
}

function activitySkeletons() {
  return Array.from({ length: WAITING_ROWS }, (_unused, i) =>
    el('div', { class: 'act-row' }, [
      el('span', { class: 'act-arrow' }, [bar('9px', 9)]),
      el('span', { class: 'act-body' }, [
        el('span', { class: 'act-line' }, [bar(`${52 - i * 6}%`, 13)]),
        el('span', { class: 'act-line' }, [bar(`${64 - i * 6}%`, 10)]),
      ]),
    ]),
  );
}

// --- home -------------------------------------------------------------------

async function homeView(keys, key, net) {
  const pending = await pendingList(net.label);

  // `role="status"` so the figure is spoken once it resolves. The balance is
  // the answer to the question the wallet was opened to ask, and it arrives
  // after the document does — which for a screen reader means it never arrived.
  const balance = el('div', { class: 'balance', role: 'status', 'aria-busy': 'true' }, [
    el('div', { class: 'balance-num' }, [bar('62%', 30)]),
    // Words, not a second grey bar. The figure above it is a placeholder because
    // its shape is the information; this line's job is to say why the figure is
    // not there yet, and a shimmer cannot say that. It also means a node that is
    // being slow reads as a node being slow rather than as a broken screen.
    el('div', { class: 'balance-sub' }, 'reading balances…'),
  ]);
  const holdings = el('div', { 'aria-busy': 'true' }, holdingSkeletons());
  const activity = el('div', { 'aria-busy': 'true' }, activitySkeletons());

  loadBalances(net, key.address, balance, holdings);
  loadActivity(net, key.address, activity);

  return [
    topBar(net),
    accountRow(key, net, { keys }),
    balance,
    el('div', { class: 'actions' }, [
      el('button', { class: 'fill', onclick: () => go('send', key.label) }, '↑  Send'),
      el('button', { onclick: () => go('receive', key.label) }, '↓  Receive'),
    ]),
    el('div', { class: 'sec-head' }, [el('span', {}, 'Holdings')]),
    holdings,
    el('div', { class: 'sec-head' }, [el('span', {}, 'Activity')]),
    activity,
    pending.length ? pendingPanel(pending, net) : null,
    el('div', { class: 'sec-head' }, [
      el('span', {}, 'Wallet'),
      el('button', { class: 'chip', onclick: () => go('keys', key.label) }, `Manage keys (${keys.length})`),
    ]),
  ].filter(Boolean);
}

/**
 * The headline figure, and everything under it.
 *
 * The native balance is the headline because it is what fees are paid in and
 * what "do I have enough" means. Amounts here come from `currencybalance`,
 * which is denominated in COINS — so they go through `coinsShort`, never the
 * SDK's `formatCoins`, which expects satoshis and would render 4.76 dudecoin as
 * 0.00000004.
 */
async function loadBalances(net, address, balanceNode, holdingsNode) {
  const done = () => {
    balanceNode.setAttribute('aria-busy', 'false');
    holdingsNode.setAttribute('aria-busy', 'false');
  };
  // Started first and awaited last. It is two reads against the same node, and
  // the balances underneath take several more — so by the time there is anything
  // to price, the prices are already here and the figure renders once rather
  // than appearing and then growing a second line.
  const prices = priceBook(net.node);

  try {
    const held = await currencyBalances(net.node, address);
    const names = held.length ? await currencyNames(net.node, held.map((h) => h.id)) : new Map();
    const nameOf = (id) => names.get(id) ?? id;

    const native = held.find((h) => nameOf(h.id) === net.native);
    const others = held.filter((h) => h !== native);
    const identities = await controlledIdentities(net.node, address);
    const book = await prices;
    const worth = (holding) => {
      const price = book.get(holding.id);
      return Number.isFinite(price) ? valueOf(holding.amount * price) : null;
    };

    mount(
      balanceNode,
      ...headline(native ? native.amount : 0, net, others.length, identities.length, native ? worth(native) : null),
    );

    if (held.length === 0 && identities.length === 0) {
      mount(
        holdingsNode,
        el('div', { class: 'muted small' }, 'nothing held yet'),
        // An empty testnet wallet is otherwise a dead end: the balance is zero,
        // Send correctly offers nothing, and no screen says where coins come
        // from. On mainnet there is nothing useful to say, so nothing is said.
        net.real
          ? null
          : el('div', { class: 'help' }, [
              'Test coins are free — ask in the ',
              el('a', { href: 'https://discord.gg/VRKMP2S', target: '_blank', rel: 'noopener noreferrer' }, 'Verus Discord'),
              ', or use the address above with any VRSCTEST faucet.',
            ]),
      );
      done();
      return;
    }

    // Ranked, because `currencybalance` comes back ordered by raw amount and
    // raw amounts are not comparable across currencies: a testnet token minted
    // with a supply of a billion outranks every real holding, and the list is
    // capped, so the coin somebody actually has is the one pushed out of sight.
    //
    // Native first — it is what fees are paid in — then whatever can be priced,
    // by what it is worth, then the rest by amount.
    const ranked = [...held].sort((a, b) => {
      const nativeA = nameOf(a.id) === net.native;
      const nativeB = nameOf(b.id) === net.native;
      if (nativeA !== nativeB) return nativeA ? -1 : 1;
      const valueA = book.has(a.id) ? a.amount * book.get(a.id) : null;
      const valueB = book.has(b.id) ? b.amount * book.get(b.id) : null;
      if ((valueA === null) !== (valueB === null)) return valueA === null ? 1 : -1;
      if (valueA !== null) return valueB - valueA;
      return b.amount - a.amount;
    });

    // Kept alongside the rows rather than read back out of the DOM, so the
    // filter matches on the name the row was built from — including the
    // identity that holds it, which is a thing people search for by.
    const rowNames = ranked.map((h) => nameOf(h.id));
    const rows = ranked.map((h) =>
      holdingRow(el('span', { class: nameOf(h.id) === net.native ? 'hold-dot' : 'hold-dot token' }), nameOf(h.id), h, worth(h)),
    );

    // Listed separately rather than summed in. What an identity holds is yours
    // to spend, but spending it is a different transaction — funded from the
    // identity's outputs — so folding the two together would suggest a single
    // pot that does not exist.
    const identityIds = [...new Set(identities.flatMap((i) => i.held.map((h) => h.id)))];
    const identityNames = identityIds.length ? await currencyNames(net.node, identityIds) : new Map();
    for (const identity of identities) {
      for (const h of identity.held) {
        const name = identityNames.get(h.id) ?? h.id;
        rowNames.push(`${name} ${identity.name}@`);
        rows.push(
          holdingRow(
            el('span', { class: 'hold-dot token' }),
            name,
            h,
            worth(h),
            el('span', { class: 'tag' }, `${identity.name}@`),
          ),
        );
      }
    }
    mountHoldings(holdingsNode, rows, rowNames);
    done();
  } catch (error) {
    mount(balanceNode, el('div', { class: 'warn small' }, error?.message ?? 'balances unavailable'));
    mount(holdingsNode);
    done();
  }
}

/**
 * The holdings list, with a tail that opens.
 *
 * Chrome gives a toolbar popup 600px and this list is unbounded — a wallet
 * holding a dozen currencies pushed Activity and everything after it out of
 * reach — so it is still capped. What changed is that the cap is now a door
 * rather than a wall: "+ 5 more" was the one place the interface told you
 * something existed and then refused to show it, which is worse than not
 * mentioning it, because it leaves somebody looking for a control that is not
 * there.
 *
 * Opening it may push the popup past 600px and Chrome will scroll. That is the
 * right trade when a person has just asked to see the rest, and it is why the
 * list is not simply uncapped: the cost is paid by whoever asks for it.
 */
function mountHoldings(node, rows, names = []) {
  const SHOWN = 5;
  if (rows.length <= SHOWN) {
    mount(node, ...rows);
    return;
  }

  // Only past the point where scanning stops working. A filter above three rows
  // is a control looking for a job; above a dozen it is the only way to find the
  // one currency somebody came here for. Ranking fixed the top of the list —
  // this fixes the tail.
  const FILTERABLE = 8;
  if (rows.length >= FILTERABLE) {
    const box = el('input', {
      type: 'search',
      class: 'filter',
      placeholder: `Filter ${rows.length} currencies`,
      'aria-label': 'Filter holdings',
      autocomplete: 'off',
    });
    box.addEventListener('input', () => {
      const needle = box.value.trim().toLowerCase();
      if (!needle) return mountHoldings(node, rows, names);
      const hits = rows.filter((_row, i) => names[i]?.toLowerCase().includes(needle));
      mount(node, box, ...(hits.length ? hits : [el('div', { class: 'muted small' }, 'nothing matches')]));
      box.focus({ preventScroll: true });
      // The caret goes to the end rather than the start, which is where
      // re-mounting an input would otherwise leave it.
      box.setSelectionRange(box.value.length, box.value.length);
    });
    mount(node, box, ...rows.slice(0, SHOWN), tail(node, rows, SHOWN, names, box));
    return;
  }

  mount(node, ...rows.slice(0, SHOWN), tail(node, rows, SHOWN, names, null));
}

function tail(node, rows, shown, names, box) {
  const toggle = el('button', { class: 'more', 'aria-expanded': 'false' }, `+ ${rows.length - shown} more`);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.textContent = open ? `+ ${rows.length - shown} more` : 'Show fewer';
    mount(node, box, ...(open ? rows.slice(0, shown) : rows), toggle);
    toggle.focus({ preventScroll: true });
  });
  return toggle;
}

function headline(coins, net, otherCount, identityCount, worth) {
  const [whole, decimals] = coinsShort(coins).split('.');
  const extras = [];
  if (otherCount) extras.push(`${otherCount} other ${otherCount === 1 ? 'currency' : 'currencies'}`);
  if (identityCount) extras.push(`${identityCount} ${identityCount === 1 ? 'identity' : 'identities'}`);

  return [
    el('div', { class: 'balance-num' }, [
      whole,
      decimals ? el('span', { class: 'dec' }, `.${decimals}`) : null,
      el('span', { class: 'balance-unit' }, net.native),
    ].filter(Boolean)),
    el('div', { class: 'balance-sub' }, [
      // First, because it is the line people can actually judge a number
      // against. Absent rather than zero when the basket cannot be read — a
      // wallet claiming a balance is worth nothing is worse than one saying
      // nothing about what it is worth.
      worth ? valueLabel(worth) : null,
      worth && extras.length ? ' · ' : null,
      extras.length ? `+ ${extras.join(' · ')}` : worth ? null : 'nothing else held',
    ].filter(Boolean)),
  ];
}

/**
 * A value, marked as an approximation and as which unit.
 *
 * `≈` rather than `=` on purpose: this is a mid price off a basket's reserves,
 * so it is what the holding is worth and not what a conversion would pay. The
 * `title` carries the full `DAI.vETH`, because the shortened label says which
 * asset while the long form says which bridge it arrived over.
 */
function valueLabel(text) {
  return el('span', { class: 'worth', title: `Approximate value in ${UNIT_FULL}, priced by ${'bridge.vETH'}` }, [
    `≈ ${text} `,
    el('span', { class: 'worth-unit' }, UNIT_LABEL),
  ]);
}

/**
 * One holding, with what it is worth underneath what there is of it.
 *
 * Stacked rather than laid out in a third column: at 360px a currency name, an
 * amount and a value on one line leaves nothing room to breathe, and the name is
 * the part that has to survive — it can be a 34-character id when a lookup fails.
 *
 * Nothing at all where there is no price, rather than a dash. The basket prices
 * what is in the basket, and on a chain where anybody can define a currency that
 * is a small minority of what a wallet holds — sixteen holdings, one priced, was
 * the measured case. A column of fifteen dashes is noise, and it makes the row
 * two lines tall to say nothing. The ranking above puts everything priceable at
 * the top, so the gap reads as the end of the priced block rather than as a
 * value that failed to load.
 */
function holdingRow(dot, name, holding, worth, tag = null) {
  return el('div', { class: 'hold-row' }, [
    dot,
    el('span', { class: 'hold-name' }, name),
    tag,
    el('span', { class: 'hold-amount' }, [
      el('span', { class: 'hold-num' }, coinsShort(holding.amount)),
      worth ? el('span', { class: 'hold-worth' }, `≈ ${worth}`) : null,
    ].filter(Boolean)),
  ].filter(Boolean));
}

/**
 * "Did it land?" — the second question a wallet is opened to answer.
 *
 * The list used to say "Sent 12.5, 2h" and stop there, which answers neither
 * half of it: not whether the transaction has confirmed, and not where the money
 * went. Both are now on the row.
 *
 * Confirmations are shown only while they are still interesting. Six deep is
 * settled by any ordinary standard and a permanent "8231 confirmations" beside
 * every historic payment is noise that hides the one row that is still moving.
 */
const SETTLED_AT = 6;

async function loadActivity(net, address, container) {
  try {
    const rows = await recentActivity(net.node, address, 3);
    container.setAttribute('aria-busy', 'false');
    if (rows.length === 0) {
      mount(container, el('div', { class: 'muted small' }, 'nothing yet'));
      return;
    }
    mount(container, ...rows.map((row) => activityRow(row, net, address)));
  } catch {
    container.setAttribute('aria-busy', 'false');
    mount(container, el('div', { class: 'muted small' }, 'activity unavailable'));
  }
}

function activityRow(row, net, address) {
  const incoming = row.direction === 'in';
  const amount = `${incoming ? '+' : '−'}${coinsShort(row.coins)}`;

  // Starts as the transaction's own id and is replaced by whoever was on the
  // other end once that read comes back. Never a spinner and never a guess: at
  // every moment it shows something true, it just gets more useful.
  //
  // The preposition lives inside it rather than beside it, because "to" belongs
  // to an address and not to a transaction id — a fallback reading "to #2d0683…"
  // states something false about what that string is.
  const who = el('span', { class: 'act-who' }, [`#${elide(row.txid, 6, 4)}`]);
  fillCounterparty(who, row, net, address);

  const state = row.pending
    ? el('span', { class: 'pill pending' }, 'Pending')
    : row.confirmations > 0 && row.confirmations < SETTLED_AT
      ? el('span', { class: 'pill' }, `${row.confirmations}/${SETTLED_AT}`)
      : null;

  // An anchor, not a click handler: it is a navigation, so it wants the middle
  // click, the context menu and the status bar that come free with one. Nothing
  // is fetched — see the note on `explorerTx` in rpc.js.
  return el(
    'a',
    {
      class: `act-row ${incoming ? 'in' : 'out'}`,
      href: `${net.explorerTx}${row.txid}`,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Open this transaction in the block explorer',
    },
    [
      el('span', { class: 'act-arrow' }, incoming ? '↙' : '↗'),
      el('span', { class: 'act-body' }, [
        el('span', { class: 'act-line' }, [
          el('span', { class: 'act-amount' }, [amount, el('span', { class: 'act-unit' }, net.native)]),
          el('span', { class: 'act-when' }, row.pending ? 'just now' : ago(row.time)),
        ]),
        el('span', { class: 'act-line' }, [
          el('span', { class: 'act-sub' }, [who]),
          state,
        ].filter(Boolean)),
      ]),
    ],
  );
}

/**
 * Name the other end, if the chain says who it was.
 *
 * Deliberately fire-and-forget: it is one more read per row and the list has
 * already painted. A failure leaves the transaction id in place, which is worse
 * to read and still true — the wrong direction to fail in would be to guess.
 */
async function fillCounterparty(node, row, net, address) {
  const found = await counterparty(net.node, row.txid, address).catch(() => null);
  if (!found) return;

  const others = row.direction === 'in' ? found.paidBy : found.paid;
  if (!others?.length) return;

  mount(
    node,
    row.direction === 'in' ? 'from ' : 'to ',
    addressEl(others[0], { short: true }),
    others.length > 1 ? el('span', { class: 'muted' }, ` +${others.length - 1}`) : null,
  );
}

// --- the first thirty seconds -----------------------------------------------

/**
 * The screen that decides whether somebody keeps their coins.
 *
 * It used to be `no keys yet`, two unlabelled placeholders and a button — 386
 * pixels in which the most consequential and least reversible decision in the
 * product was made with nothing said about it. Nothing explained what the
 * passphrase was for, that it cannot be reset, that there is nobody to ask, or
 * that this is a chain where the coins are not real.
 *
 * All of that was true and written down; it was written down in a README, which
 * is not where the decision happens.
 *
 * Importing is demoted to a line of text. It is the rarer path, and "WIF" was
 * jargon in the first sentence a new user ever read.
 */
function firstRun(net, pending) {
  const create = el('div', {}, createForm(net, { welcome: true }));
  const importer = el('div', {});
  const alt = el('div', { class: 'alt' }, [
    'Already have a key? ',
    el(
      'button',
      {
        type: 'button',
        onclick: () => {
          mount(alt);
          mount(importer, importPanel(true));
          importer.querySelector('input')?.focus({ preventScroll: true });
        },
      },
      'Import one',
    ),
  ]);

  return [
    topBar(net, { plain: true }),
    el('div', { class: 'welcome' }, [
      el('h2', {}, 'Make a wallet'),
      el('p', {}, [
        'The key is created on this computer and never leaves it. You are on ',
        el('span', { class: 'chain-word' }, net.label),
        net.real
          ? ' — this chain spends real money. Consider starting on VRSCTEST instead.'
          : ', where the coins are not worth anything — the right place to learn it.',
      ]),
    ]),
    create,
    importer,
    alt,
    // A claim can outlive the key that made it: the record is all that is left
    // of a fee already spent, and this is the only screen that can clear it.
    pending.length ? pendingPanel(pending, net) : null,
  ].filter(Boolean);
}

// --- receive ----------------------------------------------------------------

/**
 * Being paid.
 *
 * This screen used to be a grouped address and a copy button, with a comment
 * explaining that a QR was missing on purpose: an encoder that is subtly wrong
 * produces a code that scans cleanly to the wrong address, and there was nothing
 * here to check one against. Both halves of that are now answered — the encoder
 * is vendored rather than written, and the test suite decodes the drawn pixels
 * and compares them to the address. See `lib/qr.js`.
 *
 * The address stays underneath it, in full and grouped. The QR is for a phone;
 * the text is for a person checking they are about to be paid at the right
 * place, and neither substitutes for the other.
 */
function receiveView(key, net) {
  const status = el('div', { class: 'help', role: 'status' }, 'Only send VRSC-family assets on this chain to this address.');

  let code = null;
  try {
    code = el('div', { class: 'qr' }, [qrCanvas(key.address)]);
  } catch {
    // A missing QR is a smaller failure than a broken Receive screen, and the
    // address below it is the authoritative copy either way.
    code = null;
  }

  return [
    topBar(net, { back: 'home', title: 'Receive' }),
    accountRow(key, net, { action: false }),
    code,
    el('div', { class: 'sec-head' }, [el('span', {}, `Your ${net.label} address`)]),
    el('div', { class: 'receive-addr' }, [addressEl(key.address)]),
    el('div', { class: 'actions' }, [
      el(
        'button',
        {
          class: 'fill',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(key.address);
              mount(status, el('span', { class: 'accent' }, 'Address copied'));
            } catch {
              mount(status, el('span', { class: 'warn' }, 'Could not reach the clipboard — select it above.'));
            }
          },
        },
        'Copy address',
      ),
    ]),
    status,
  ].filter(Boolean);
}

// --- send -------------------------------------------------------------------

/**
 * Everything this key can move, in the order the balance list shows it.
 *
 * The distinction decides which of the SDK's four send flows builds the
 * transaction, so it is worked out from the same two reads the home view
 * already makes rather than guessed at later. Native held by an identity gets
 * its own path: `currencybalance` includes the chain's own coin, so an
 * identity's holdings legitimately contain it, and routing that through the
 * token flow would treat native as a token and fail unreadably.
 */
function sendables(net, own, identities, names) {
  const nameOf = (id) => names.get(id) ?? id;
  const isNative = (id) => nameOf(id) === net.native;
  const found = [];

  for (const holding of own) {
    found.push({
      path: isNative(holding.id) ? SEND_PATH.NATIVE : SEND_PATH.TOKEN,
      currency: holding.id,
      currencyName: nameOf(holding.id),
      label: nameOf(holding.id),
      amount: holding.amount,
    });
  }

  for (const identity of identities) {
    // Offered only where this key is a primary address and one signature is
    // enough; anything else is refused by the SDK after the passphrase has been
    // typed, which is the worst possible moment to find out.
    if (identity.spendable === false) continue;
    for (const holding of identity.held) {
      found.push({
        path: isNative(holding.id) ? SEND_PATH.IDENTITY_NATIVE : SEND_PATH.IDENTITY_TOKEN,
        currency: holding.id,
        currencyName: nameOf(holding.id),
        identity: `${identity.name}@`,
        label: `${nameOf(holding.id)} (${identity.name}@)`,
        amount: holding.amount,
      });
    }
  }

  return found;
}

function sendView(keys, key, net) {
  const asset = el('select', { 'aria-label': 'asset', disabled: true }, [el('option', {}, 'reading balances…')]);
  const to = el('input', {
    type: 'text',
    placeholder: 'R… address, i… address, or name@',
    autocomplete: 'off',
    // The verdict on what has been typed is two lines below the field. Bound to
    // it rather than merely near it, so a screen reader reads it out with the
    // field instead of leaving it as something to go looking for.
    'aria-describedby': 'to-help',
  });
  const amount = el('input', {
    type: 'text',
    inputmode: 'decimal',
    placeholder: 'amount',
    autocomplete: 'off',
    'aria-describedby': 'amount-help',
  });
  const toHelp = el(
    'div',
    { class: 'help', id: 'to-help', 'aria-live': 'polite' },
    'An address, or an identity written with its @.',
  );
  const amountHelp = el('div', { class: 'help', id: 'amount-help', 'aria-live': 'polite' }, ' ');
  const status = el('div', { class: 'status small', role: 'status' });
  const review = el('button', { class: 'fill', disabled: true }, 'Review payment');
  const recents = el('div', { class: 'recents' });
  const amountWorth = el('span', { class: 'amount-worth' }, ' ');

  let options = [];

  const chosen = () => options[Number(asset.value)] ?? null;

  // The balance above is already priced against the bridge basket, so the form
  // can answer "how much is that" while somebody is typing — for the cost of a
  // multiplication. Absent, never zero, for anything the basket cannot price.
  let prices = new Map();
  priceBook(net.node)
    .then((book) => {
      prices = book;
      refreshAmountHelp();
    })
    .catch(() => {});

  const inDai = (currencyId, coins) => {
    const price = prices.get(currencyId);
    if (!Number.isFinite(price)) return null;
    const text = valueOf(coins * price);
    return text ? `≈ ${text} ${UNIT_LABEL}` : null;
  };

  const refreshAmountHelp = () => {
    const pick = chosen();
    if (!pick) return mount(amountHelp, ' ');
    const value = Number(amount.value);
    if (!amount.value.trim() || !Number.isFinite(value)) {
      mount(amountWorth, ' ');
      return mount(amountHelp, `${coinsShort(pick.amount)} ${pick.currencyName} available`);
    }
    mount(amountWorth, inDai(pick.currency, value) ?? ' ');
    const left = pick.amount - value;
    if (left < 0) {
      return mount(
        amountHelp,
        el('span', { class: 'bad' }, `That is more than the ${coinsShort(pick.amount)} available`),
      );
    }
    const rest = inDai(pick.currency, left);
    return mount(amountHelp, `Leaves ${coinsShort(left)} ${pick.currencyName}${rest ? ` · ${rest}` : ''}`);
  };

  // A later keystroke must win. `parseDestination` hashes, so without this a
  // fast typist gets the verdict on a prefix rendered under a finished address.
  let seq = 0;
  const checkDestination = async () => {
    const mine = ++seq;
    const text = to.value.trim();
    if (!text) {
      if (mine !== seq) return;
      toHelp.className = 'help';
      to.removeAttribute('aria-invalid');
      mount(toHelp, 'An address, or an identity written with its @.');
      return;
    }
    try {
      const parsed = await parseDestination(text);
      if (mine !== seq) return;
      toHelp.className = 'help good';
      to.setAttribute('aria-invalid', 'false');
      mount(toHelp, parsed.kind === 'name' ? '✓ An identity — checked when you review' : '✓ Valid address · checksum verified');
    } catch (error) {
      if (mine !== seq) return;
      toHelp.className = 'help bad';
      // So the field itself carries the verdict, not only the line under it.
      to.setAttribute('aria-invalid', 'true');
      mount(toHelp, error.message);
    }
  };

  to.addEventListener('input', checkDestination);

  // Somebody already paid: offered as a chip rather than as a dropdown, because
  // there are at most a handful and a chip shows the address itself. Filling the
  // field runs the same check a keystroke does — a stored address is still shown
  // being verified, never waved through because it came from us.
  loadRecipients(net, recents, (chosen) => {
    to.value = chosen;
    checkDestination();
    to.focus();
  });

  amount.addEventListener('input', refreshAmountHelp);
  asset.addEventListener('change', refreshAmountHelp);

  const max = el(
    'button',
    {
      class: 'max-btn',
      onclick: () => {
        const pick = chosen();
        // Native only ever gets a MAX when it is not paying the miner fee:
        // `planSend` chooses the fee itself and will not say what it is, so a
        // native maximum builds a transaction that always fails on funds.
        if (!pick || pick.path === SEND_PATH.NATIVE) return;
        amount.value = String(pick.amount);
        refreshAmountHelp();
      },
    },
    'MAX',
  );

  loadSendables(net, key, asset, review, (found) => {
    options = found;
    refreshAmountHelp();
    max.disabled = !chosen() || chosen().path === SEND_PATH.NATIVE;
  });

  review.addEventListener('click', async () => {
    review.disabled = true;
    try {
      const pick = chosen();
      if (!pick) throw new Error('There is nothing in this wallet to send yet.');
      await parseDestination(to.value);
      const value = amount.value.trim();
      if (!/^\d+(\.\d{1,8})?$/.test(value) || Number(value) <= 0) {
        throw new Error('Enter a positive amount with at most 8 decimal places.');
      }

      // Nothing after this runs. Opening the approval window takes focus from
      // the toolbar popup, which destroys this document mid-promise — so there
      // is no success path to render, and no error worth catching except the
      // one that means the window never opened.
      await chrome.runtime.sendMessage({
        type: PORT.LOCAL_REQUEST,
        params: {
          path: pick.path,
          to: to.value.trim(),
          amount: value,
          currency: pick.currency,
          currencyName: pick.currencyName,
          identity: pick.identity,
          keyLabel: key.label,
        },
      });
    } catch (error) {
      mount(status, el('span', { class: 'danger' }, error?.message ?? 'Could not start the payment.'));
      review.disabled = false;
    }
  });

  return [
    topBar(net, { back: 'home', title: 'Send' }),
    el('div', { class: 'field' }, [el('label', {}, 'Asset'), asset]),
    el('div', { class: 'field' }, [el('label', {}, 'To'), to, toHelp, recents]),
    el('div', { class: 'field' }, [
      el('label', {}, 'Amount'),
      el('div', { class: 'amount-wrap' }, [
        amount,
        el('div', { class: 'amount-suffix' }, [amountWorth, max]),
      ]),
      amountHelp,
    ]),
    el('div', { class: 'facts' }, [
      el('div', { class: 'fact' }, [
        el('span', { class: 'fact-k' }, 'Network fee'),
        // "shown before you sign" reads as something being withheld. What is
        // true is that `planSend` picks the fee while building and will not
        // quote one beforehand, so nothing here could show it.
        el('span', { class: 'fact-v muted' }, 'the chain sets it · next screen'),
      ]),
    ]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'secondary', onclick: () => go('home') }, 'Cancel'),
      review,
    ]),
    status,
  ];
}

/**
 * The last few destinations this wallet has actually paid, per chain.
 *
 * Rendered only when there are some: an empty "Recent" heading is a promise the
 * screen cannot keep, and a first-time sender should not be shown the shape of a
 * feature they have not used yet.
 *
 * The clear control is next to them rather than buried in settings, because the
 * reason to want it — a shared or borrowed machine — is a reason to want it
 * *now*, not after a hunt.
 */
async function loadRecipients(net, node, onPick) {
  const found = await recentRecipients(net.label).catch(() => []);
  if (found.length === 0) return;

  const chips = found.map((entry) =>
    el(
      'button',
      { class: 'recent-chip', type: 'button', title: entry, onclick: () => onPick(entry) },
      [entry.endsWith('@') ? entry : addressEl(entry, { short: true, emphasise: false })],
    ),
  );

  mount(
    node,
    el('div', { class: 'recents-head' }, [
      el('span', {}, 'Paid before'),
      el(
        'button',
        {
          class: 'link-btn',
          type: 'button',
          onclick: async () => {
            await clearRecipients(net.label);
            mount(node);
          },
        },
        'Clear',
      ),
    ]),
    el('div', { class: 'recents-row' }, chips),
  );
}

async function loadSendables(net, key, assetSelect, review, onReady) {
  try {
    const own = await currencyBalances(net.node, key.address);
    const identities = await controlledIdentities(net.node, key.address);
    const ids = [...new Set([...own, ...identities.flatMap((i) => i.held)].map((h) => h.id))];
    const names = ids.length ? await currencyNames(net.node, ids) : new Map();
    const found = sendables(net, own, identities, names);

    if (found.length === 0) {
      // A disabled control has to say what would enable it. The old form left
      // "review" grey next to an unrelated address error, so someone could fix
      // the address and never learn why nothing happened.
      mount(assetSelect, el('option', {}, 'nothing to send'));
      review.disabled = true;
      review.title = 'This wallet holds nothing on this chain yet.';
      onReady([]);
      return;
    }

    mount(assetSelect, ...found.map((o, i) => el('option', { value: String(i) }, `${o.label} — ${coinsShort(o.amount)}`)));
    assetSelect.disabled = false;
    review.disabled = false;
    onReady(found);
  } catch (error) {
    mount(assetSelect, el('option', {}, 'balances unavailable'));
    review.disabled = true;
    review.title = error?.message ?? 'Could not read balances.';
    onReady([]);
  }
}

// --- keys, and everything that can destroy something ------------------------

/**
 * Keys, and what you are allowed to do with one.
 *
 * Until now: remove. That was the only verb on this screen, for a key the wallet
 * itself had generated — so a second key was stored and then unreachable, and a
 * key could be deleted but never saved. The delete dialog even said "if this key
 * is not backed up elsewhere, its funds are gone", which was true and which the
 * wallet gave you no way to act on.
 */
function keysView(keys, active, net) {
  return [
    topBar(net, { back: 'home', title: 'Wallet' }),
    panel('keys', el('div', { class: 'keylist' }, keys.map((k) => keyRow(k, k.label === active.label, net)))),
    createPanel(net),
    importPanel(),
  ];
}

function keyRow(key, isActive, net) {
  const drawer = el('div', {});

  const use = el(
    'button',
    { class: 'mini', onclick: () => go('home', key.label) },
    'Use',
  );

  const backup = el(
    'button',
    {
      class: 'mini',
      'aria-expanded': 'false',
      onclick: () => {
        const open = backup.getAttribute('aria-expanded') === 'true';
        backup.setAttribute('aria-expanded', String(!open));
        if (open) return mount(drawer);
        mount(drawer, backupPanel(key));
        drawer.querySelector('input')?.focus({ preventScroll: true });
      },
    },
    'Back up',
  );

  const forget = el(
    'button',
    {
      class: 'mini danger-zone',
      onclick: async () => {
        // Deleting a key deletes the coins. Ask, every time — and now the
        // question can honestly point at the way out, because there is one.
        if (!confirm(`Remove "${key.label}"?\n\nIf you have not backed this key up, its funds are gone and nobody can recover them. Back it up first if you are unsure.`)) {
          return;
        }
        await remove(key.label);
        view = { name: 'home', key: null };
        await render();
      },
    },
    'Remove',
  );

  return el('div', { class: 'keyrow' }, [
    el('div', { class: 'keyrow-head' }, [
      el('div', {}, [
        el('div', { class: 'accent' }, [
          key.label,
          isActive ? el('span', { class: 'pill', style: 'margin-left:0.4rem' }, 'Active') : null,
        ].filter(Boolean)),
        el('div', { class: 'acct-addr' }, [addressEl(key.address)]),
      ]),
    ]),
    el('div', { class: 'keyrow-acts' }, [isActive ? null : use, backup, forget].filter(Boolean)),
    drawer,
  ]);
}

/**
 * Show the key, once, to somebody who has just proved they know the passphrase.
 *
 * This is the only place in the extension besides the approval window where a
 * WIF exists in plaintext, and it is deliberately the same shape: the passphrase
 * is required, the decryption happens in this document, and nothing is written
 * anywhere. What is different is that here it is *displayed*, which is the whole
 * point — a key that cannot leave the browser is a key that dies with the
 * browser profile.
 *
 * The warning is placed where it applies rather than in a README. Somebody about
 * to photograph a private key is not going to be stopped by documentation.
 */
function backupPanel(key) {
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'current-password' });
  const status = el('div', { class: 'status small', role: 'status' });
  const out = el('div', {});

  const reveal = el(
    'button',
    {
      onclick: async () => {
        mount(status, el('span', { class: 'muted' }, 'Unlocking…'));
        try {
          const wif = await openVault(key, pass.value);
          pass.value = '';
          ask.style.display = 'none';
          mount(status);
          mount(
            out,
            el('div', { class: 'secret' }, wif),
            el(
              'div',
              { class: 'note bad' },
              'Anyone who reads this owns the coins. Do not photograph it, do not paste it into a chat, and do not put it anywhere you do not control.',
            ),
            el('div', { class: 'buttons', style: 'margin-top:0.5rem' }, [
              el(
                'button',
                {
                  class: 'secondary',
                  onclick: async () => {
                    try {
                      await navigator.clipboard.writeText(wif);
                      mount(status, el('span', { class: 'warn' }, 'Copied — your clipboard now holds the key.'));
                    } catch {
                      mount(status, el('span', { class: 'warn' }, 'Could not reach the clipboard — select it above.'));
                    }
                  },
                },
                'Copy',
              ),
              el(
                'button',
                {
                  onclick: () => {
                    mount(out);
                    mount(status);
                    ask.style.display = '';
                    pass.focus({ preventScroll: true });
                  },
                },
                'Hide',
              ),
            ]),
          );
        } catch (error) {
          mount(status, el('span', { class: 'danger' }, error?.message ?? 'wrong passphrase'));
        }
      },
    },
    'Reveal',
  );

  // Hidden while the key is on screen: the field is empty, the button would only
  // repeat what is already there, and both together read as an unfinished step.
  const ask = el('div', {}, [
    el(
      'div',
      { class: 'help' },
      'The key is decrypted in this window and shown once. Write it down or store it somewhere only you can reach — it is the only thing that can recover these coins if this browser is lost.',
    ),
    pass,
    el('div', { class: 'buttons' }, [reveal]),
  ]);

  return el('div', { class: 'reveal' }, [
    el('div', { class: 'reveal-title' }, `Back up “${key.label}”`),
    ask,
    status,
    out,
  ]);
}

/**
 * Half-finished name claims, and a way out of them.
 *
 * A commitment can get stuck: it expires, it is dropped, or an attempt fails
 * between the two transactions. The launch page then keeps offering "finish
 * claiming" for a name that can never complete, with no way to see why or to
 * clear it — the state lives only here, because only the wallet holds the salt.
 *
 * Discarding is deliberately blunt and deliberately warned about: the
 * commitment fee is already spent and abandoning the record makes it
 * unrecoverable. It is still the right escape hatch, because the alternative is
 * a wizard permanently stuck on a dead step.
 */
function pendingPanel(pending, net) {
  return panel('claims in progress', [
    ...pending.map((entry) =>
      el('div', { class: 'keyrow' }, [
        el('div', { class: 'keyrow-head' }, [
          el('div', {}, [
            el('div', { class: 'accent' }, `${entry.name}@`),
            el(
              'div',
              { class: 'addr' },
              entry.commitmentTxid ? `commitment ${elide(entry.commitmentTxid)}` : 'no commitment recorded',
            ),
          ]),
          el(
            'button',
            {
              class: 'secondary',
              style: 'flex:0 0 auto;padding:0.1rem 0.4rem;font-size:11px',
              onclick: async () => {
                if (
                  !confirm(
                    `Discard the claim on "${entry.name}@"?\n\nIts registration fee is already spent and cannot be recovered. Only do this if the commitment can never complete.`,
                  )
                ) {
                  return;
                }
                await forgetPending(net.label, entry.name);
                await render();
              },
            },
            'discard',
          ),
        ]),
      ]),
    ),
    el(
      'p',
      { class: 'muted small' },
      'Each of these is waiting for its second transaction. Finish one from the page that started it; discard only if it can never complete.',
    ),
  ]);
}

/**
 * Making a key, in two dresses.
 *
 * `welcome` is the first-run version: labelled fields, what each one is for, and
 * the irreversibility stated where the decision is made rather than in a README.
 * Without it this is the folded panel on the keys screen, where the person
 * reading it has already done this once.
 *
 * The fields carry ids and real `<label for>` associations, so the form is
 * navigable by label rather than by placeholder — and so a test can ask for
 * "Passphrase" instead of matching on a placeholder that is really just a hint.
 */
function createForm(net, { welcome = false } = {}) {
  const label = el('input', {
    type: 'text',
    id: 'new-label',
    placeholder: welcome ? 'savings' : 'label',
    autocomplete: 'off',
  });
  const pass = el('input', {
    type: 'password',
    id: 'new-pass',
    placeholder: welcome ? '' : 'passphrase',
    autocomplete: 'new-password',
  });
  const passHelp = el('div', { class: 'help', id: 'new-pass-help', 'aria-live': 'polite' }, ' ');
  const status = el('div', { class: 'status small', role: 'status' });

  pass.setAttribute('aria-describedby', 'new-pass-help');
  pass.addEventListener('input', () => {
    if (!pass.value) return mount(passHelp, ' ');
    if (pass.value.length < 8) {
      passHelp.className = 'help';
      return mount(passHelp, `${8 - pass.value.length} more character${pass.value.length === 7 ? '' : 's'}`);
    }
    passHelp.className = 'help good';
    return mount(passHelp, '✓ Long enough');
  });

  const button = el(
    'button',
    {
      class: welcome ? 'fill' : null,
      onclick: async () => {
        try {
          if (!label.value.trim()) throw new Error('give it a name');
          if (pass.value.length < 8) throw new Error('passphrase must be at least 8 characters');

          // 32 bytes from the browser's CSPRNG. The module is never asked to
          // invent randomness, so it never has to be trusted about it.
          const entropy = crypto.getRandomValues(new Uint8Array(32));
          const key = Key.fromEntropy(entropy);
          try {
            await add(await seal(label.value.trim(), key.address(), key.toWif(), pass.value));
          } finally {
            key.free();
            entropy.fill(0);
          }
          view = { name: 'home', key: label.value.trim() };
          await render();
        } catch (error) {
          mount(status, el('span', { class: 'danger' }, error.message));
        }
      },
    },
    welcome ? 'Create wallet' : 'create key',
  );

  if (!welcome) return [label, pass, passHelp, el('div', { class: 'buttons' }, [button]), status];

  return [
    el('div', { class: 'field' }, [
      el('label', { for: 'new-label' }, 'Name it'),
      label,
      el('div', { class: 'help' }, 'Just for you. Nothing on the chain sees this.'),
    ]),
    el('div', { class: 'field' }, [el('label', { for: 'new-pass' }, 'Passphrase'), pass, passHelp]),
    // The one thing that has to be read before the button is pressed. Stated as
    // what happens rather than as advice, because "keep it safe" is advice and
    // "there is nobody to ask" is a fact about the system.
    el(
      'div',
      { class: 'note' },
      'This cannot be reset. Not by us — there is nobody to ask. If you lose it, the coins it holds are gone. Write it down before you continue.',
    ),
    el('div', { class: 'actions' }, [button]),
    status,
  ];
}

function createPanel(net, open = false) {
  return foldout('new key', createForm(net), { open });
}

function importForm(net) {
  const wif = el('input', { type: 'password', id: 'imp-wif', placeholder: 'WIF', autocomplete: 'off' });
  const label = el('input', { type: 'text', id: 'imp-label', placeholder: 'label', autocomplete: 'off' });
  const pass = el('input', { type: 'password', id: 'imp-pass', placeholder: 'passphrase', autocomplete: 'new-password' });
  const status = el('div', { class: 'status small', role: 'status' });

  const button = el(
    'button',
    {
      onclick: async () => {
        try {
          if (!label.value.trim()) throw new Error('give it a name');
          if (pass.value.length < 8) throw new Error('passphrase must be at least 8 characters');

          const key = Key.fromWif(wif.value.trim());
          try {
            await add(await seal(label.value.trim(), key.address(), key.toWif(), pass.value));
          } finally {
            key.free();
          }
          wif.value = '';
          view = { name: 'home', key: label.value.trim() };
          await render();
        } catch (error) {
          mount(status, el('span', { class: 'danger' }, error.message));
        }
      },
    },
    'import',
  );

  return [
    el('div', { class: 'field' }, [el('label', { for: 'imp-wif' }, 'Private key (WIF)'), wif]),
    el('div', { class: 'field' }, [el('label', { for: 'imp-label' }, 'Name it'), label]),
    el('div', { class: 'field' }, [el('label', { for: 'imp-pass' }, 'Passphrase'), pass]),
    el('div', { class: 'buttons' }, [button]),
    status,
  ];
}

function importPanel(open = false) {
  return foldout('import a WIF', importForm(), { open });
}

boot().catch((error) => mount(root, el('p', { class: 'danger' }, error?.message ?? String(error))));
