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
} from '../lib/rpc.js';
import { coinsShort, elide, ago } from '../lib/fmt.js';
import { list, add, remove, seal } from '../lib/vault.js';
import { list as pendingList, forget as forgetPending } from '../lib/pending.js';
import { SEND_PATH, PORT } from '../lib/protocol.js';
import { parseDestination } from '../lib/address.js';

const root = document.getElementById('root');

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

  if (keys.length === 0) {
    view = { name: 'home', key: null };
    // Claims in progress are shown here too. A commitment can outlive the key
    // that made it — the record is all that is left of a fee that is already
    // spent — and hiding it behind "you have no keys" would make the one screen
    // that can clear it unreachable.
    const pending = await pendingList(net.label);
    return mount(
      root,
      topBar(net, { plain: true }),
      el('p', { class: 'muted' }, 'no keys yet'),
      pending.length ? pendingPanel(pending, net) : null,
      el('hr'),
      createPanel(true),
      importPanel(),
    );
  }

  const active = keys.find((k) => k.label === view.key) ?? keys[0];
  if (view.name === 'send') return mount(root, ...sendView(keys, active, net));
  if (view.name === 'receive') return mount(root, ...receiveView(active, net));
  if (view.name === 'keys') return mount(root, ...keysView(keys, net));
  return mount(root, ...(await homeView(keys, active, net)));
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
        await setNetwork(event.target.value);
        await render();
      },
    },
    Object.keys(NETWORKS).map((label) => el('option', { value: label, selected: label === net.label }, label)),
  );

  return el('div', { class: 'bar' }, plain ? [left, picker] : [left, picker]);
}

function accountRow(key, net, { action = true } = {}) {
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

  return el('div', { class: 'acct' }, [
    el('div', { class: 'avatar' }),
    el('div', { class: 'acct-id' }, [
      el('div', { class: 'acct-name' }, key.label),
      el('div', { class: 'acct-addr' }, [addressEl(key.address, { short: true })]),
    ]),
    action ? copy : null,
  ]);
}

// --- home -------------------------------------------------------------------

async function homeView(keys, key, net) {
  const pending = await pendingList(net.label);

  const balance = el('div', { class: 'balance' }, [
    el('div', { class: 'balance-num' }, '—'),
    el('div', { class: 'balance-sub' }, 'reading balances…'),
  ]);
  const holdings = el('div', {});
  const activity = el('div', { class: 'muted small' }, 'reading activity…');

  loadBalances(net, key.address, balance, holdings);
  loadActivity(net, key.address, activity);

  return [
    topBar(net),
    accountRow(key, net),
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
  try {
    const held = await currencyBalances(net.node, address);
    const names = held.length ? await currencyNames(net.node, held.map((h) => h.id)) : new Map();
    const nameOf = (id) => names.get(id) ?? id;

    const native = held.find((h) => nameOf(h.id) === net.native);
    const others = held.filter((h) => h !== native);
    const identities = await controlledIdentities(net.node, address);

    mount(balanceNode, ...headline(native ? native.amount : 0, net, others.length, identities.length));

    if (held.length === 0 && identities.length === 0) {
      mount(holdingsNode, el('div', { class: 'muted small' }, 'nothing held yet'));
      return;
    }

    const rows = held.map((h) =>
      el('div', { class: 'hold-row' }, [
        el('span', { class: nameOf(h.id) === net.native ? 'hold-dot' : 'hold-dot token' }),
        el('span', { class: 'hold-name' }, nameOf(h.id)),
        el('span', { class: 'hold-amount' }, coinsShort(h.amount)),
      ]),
    );

    // Listed separately rather than summed in. What an identity holds is yours
    // to spend, but spending it is a different transaction — funded from the
    // identity's outputs — so folding the two together would suggest a single
    // pot that does not exist.
    const identityIds = [...new Set(identities.flatMap((i) => i.held.map((h) => h.id)))];
    const identityNames = identityIds.length ? await currencyNames(net.node, identityIds) : new Map();
    for (const identity of identities) {
      for (const h of identity.held) {
        rows.push(
          el('div', { class: 'hold-row' }, [
            el('span', { class: 'hold-dot token' }),
            el('span', { class: 'hold-name' }, identityNames.get(h.id) ?? h.id),
            el('span', { class: 'tag' }, `${identity.name}@`),
            el('span', { class: 'hold-amount' }, coinsShort(h.amount)),
          ]),
        );
      }
    }
    // Chrome gives a toolbar popup 600px and this list is unbounded — a wallet
    // holding a dozen currencies pushed Activity and everything after it out of
    // reach. The count is already in the headline, so the tail is a line, not
    // eleven rows.
    const SHOWN = 6;
    const extra = rows.length - SHOWN;
    mount(
      holdingsNode,
      ...rows.slice(0, SHOWN),
      extra > 0 ? el('div', { class: 'muted small', style: 'padding-top:0.3rem' }, `+ ${extra} more`) : null,
    );
  } catch (error) {
    mount(balanceNode, el('div', { class: 'warn small' }, error?.message ?? 'balances unavailable'));
    mount(holdingsNode);
  }
}

function headline(coins, net, otherCount, identityCount) {
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
    el('div', { class: 'balance-sub' }, extras.length ? `+ ${extras.join(' · ')}` : 'nothing else held'),
  ];
}

async function loadActivity(net, address, container) {
  try {
    const rows = await recentActivity(net.node, address, 3);
    if (rows.length === 0) {
      mount(container, el('div', { class: 'muted small' }, 'nothing yet'));
      return;
    }
    mount(
      container,
      ...rows.map((row) =>
        el('div', { class: 'act-row' }, [
          el('span', { class: `act-arrow ${row.direction === 'in' ? 'in' : 'out'}` },
            row.direction === 'in' ? '↙' : row.direction === 'out' ? '↗' : '↺'),
          el('span', { class: 'act-what' },
            `${row.direction === 'in' ? 'Received' : row.direction === 'out' ? 'Sent' : 'Moved'} ${coinsShort(row.coins)}`),
          el('span', { class: 'act-when' }, ago(row.time)),
        ]),
      ),
    );
  } catch {
    mount(container, el('div', { class: 'muted small' }, 'activity unavailable'));
  }
}

// --- receive ----------------------------------------------------------------

/**
 * Being paid.
 *
 * There is no QR here, and that is a decision rather than an omission: drawing
 * one means encoding it, and a hand-written encoder that is subtly wrong
 * produces a code that scans cleanly to the wrong address. There is no way to
 * verify one in this repo — no decoder to check it against — so the honest
 * thing is a large grouped address and a copy button, and a QR later from a
 * library that someone else has already got right.
 */
function receiveView(key, net) {
  const status = el('div', { class: 'help' }, 'Only send VRSC-family assets on this chain to this address.');

  return [
    topBar(net, { back: 'home', title: 'Receive' }),
    accountRow(key, net, { action: false }),
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
  ];
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
  const to = el('input', { type: 'text', placeholder: 'R… address, i… address, or name@', autocomplete: 'off' });
  const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'amount', autocomplete: 'off' });
  const toHelp = el('div', { class: 'help' }, 'An address, or an identity written with its @.');
  const amountHelp = el('div', { class: 'help' }, ' ');
  const status = el('div', { class: 'status small' });
  const review = el('button', { class: 'fill', disabled: true }, 'Review payment');

  let options = [];

  const chosen = () => options[Number(asset.value)] ?? null;

  const refreshAmountHelp = () => {
    const pick = chosen();
    if (!pick) return mount(amountHelp, ' ');
    const value = Number(amount.value);
    if (!amount.value.trim() || !Number.isFinite(value)) {
      return mount(amountHelp, `${coinsShort(pick.amount)} ${pick.currencyName} available`);
    }
    const left = pick.amount - value;
    return mount(
      amountHelp,
      left < 0
        ? el('span', { class: 'bad' }, `That is more than the ${coinsShort(pick.amount)} available`)
        : `Leaves ${coinsShort(left)} ${pick.currencyName}`,
    );
  };

  // A later keystroke must win. `parseDestination` hashes, so without this a
  // fast typist gets the verdict on a prefix rendered under a finished address.
  let seq = 0;
  to.addEventListener('input', async () => {
    const mine = ++seq;
    const text = to.value.trim();
    if (!text) {
      if (mine === seq) mount(toHelp, 'An address, or an identity written with its @.');
      return;
    }
    try {
      const parsed = await parseDestination(text);
      if (mine !== seq) return;
      toHelp.className = 'help good';
      mount(toHelp, parsed.kind === 'name' ? '✓ An identity — checked when you review' : '✓ Valid address · checksum verified');
    } catch (error) {
      if (mine !== seq) return;
      toHelp.className = 'help bad';
      mount(toHelp, error.message);
    }
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
    el('div', { class: 'field' }, [el('label', {}, 'To'), to, toHelp]),
    el('div', { class: 'field' }, [
      el('label', {}, 'Amount'),
      el('div', { class: 'amount-wrap' }, [amount, el('div', { class: 'amount-suffix' }, [max])]),
      amountHelp,
    ]),
    el('div', { class: 'facts' }, [
      el('div', { class: 'fact' }, [
        el('span', { class: 'fact-k' }, 'Network fee'),
        el('span', { class: 'fact-v muted' }, 'shown before you sign'),
      ]),
    ]),
    el('div', { class: 'actions' }, [
      el('button', { class: 'secondary', onclick: () => go('home') }, 'Cancel'),
      review,
    ]),
    status,
  ];
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

function keysView(keys, net) {
  return [
    topBar(net, { back: 'home', title: 'Wallet' }),
    panel(
      'keys',
      el(
        'div',
        { class: 'keylist' },
        keys.map((k) =>
          el('div', { class: 'keyrow' }, [
            el('div', { class: 'keyrow-head' }, [
              el('div', {}, [
                el('div', { class: 'accent' }, k.label),
                el('div', { class: 'acct-addr' }, [addressEl(k.address)]),
              ]),
              el(
                'button',
                {
                  class: 'secondary danger-zone',
                  style: 'flex:0 0 auto;padding:0.1rem 0.4rem;font-size:11px',
                  onclick: async () => {
                    // Deleting a key deletes the coins. Ask, every time.
                    if (!confirm(`Remove "${k.label}"? If this key is not backed up elsewhere, its funds are gone.`)) return;
                    await remove(k.label);
                    view = { name: 'home', key: null };
                    await render();
                  },
                },
                'remove',
              ),
            ]),
          ]),
        ),
      ),
    ),
    createPanel(false),
    importPanel(),
  ];
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

function createPanel(open = false) {
  const label = el('input', { type: 'text', placeholder: 'label' });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password' });
  const status = el('div', { class: 'status small' });

  const button = el(
    'button',
    {
      onclick: async () => {
        try {
          if (!label.value.trim()) throw new Error('give it a label');
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
    'create key',
  );

  return foldout('new key', [label, pass, el('div', { class: 'buttons' }, [button]), status], { open });
}

function importPanel() {
  const wif = el('input', { type: 'password', placeholder: 'WIF', autocomplete: 'off' });
  const label = el('input', { type: 'text', placeholder: 'label' });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password' });
  const status = el('div', { class: 'status small' });

  const button = el(
    'button',
    {
      onclick: async () => {
        try {
          if (!label.value.trim()) throw new Error('give it a label');
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

  return foldout('import a WIF', [wif, label, pass, el('div', { class: 'buttons' }, [button]), status]);
}

boot().catch((error) => mount(root, el('p', { class: 'danger' }, error?.message ?? String(error))));
