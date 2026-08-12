// Key management and balance. No page can reach any of this.

import init, { Key } from '../vendor/verus-wasm/verus_wasm.js';
import { el, mount, row, panel, foldout } from '../lib/dom.js';
import {
  NETWORKS,
  currentNetwork,
  setNetwork,
  currencyBalances,
  currencyNames,
  controlledIdentities,
} from '../lib/rpc.js';
import { coinsShort, elide } from '../lib/fmt.js';
import { list, add, remove, seal } from '../lib/vault.js';
import { list as pendingList, forget as forgetPending } from '../lib/pending.js';
import { SEND_PATH, PORT } from '../lib/protocol.js';
import { parseDestination } from '../lib/address.js';

const root = document.getElementById('root');

async function boot() {
  await init();
  await render();
}

async function render() {
  const net = await currentNetwork();
  const keys = await list();
  const pending = await pendingList(net.label);

  // Setup is folded away once there is a key to use. Chrome caps a toolbar
  // popup at 600px and scrolls past it; rendering both forms unconditionally
  // put 426px of one-time setup in front of the balance every time, and the
  // window opened 735px tall and scrolling.
  const firstRun = keys.length === 0;

  mount(
    root,
    networkPicker(net),
    keys.length ? keysPanel(keys, net) : el('p', { class: 'muted' }, 'no keys yet'),
    keys.length ? sendPanel(keys, net) : null,
    pending.length ? pendingPanel(pending, net) : null,
    el('hr'),
    createPanel(firstRun),
    importPanel(),
  );
}

/**
 * Everything this key can move, in the order the balance list already shows it.
 *
 * The distinction that matters is not cosmetic: it decides which of the SDK's
 * four send flows the transaction is built with, so it is worked out here from
 * the same two reads the balance display already makes rather than guessed at
 * later.
 *
 * Native held by an identity gets its own path. `currencybalance` includes the
 * chain's own coin, so an identity's holdings legitimately contain it, and
 * routing that through the token flow would treat the native coin as a token
 * and fail in a way nobody could read.
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
      label: `${nameOf(holding.id)} — ${coinsShort(holding.amount)}`,
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
        label: `${nameOf(holding.id)} (${identity.name}@) — ${coinsShort(holding.amount)}`,
        amount: holding.amount,
      });
    }
  }

  return found;
}

/**
 * The send form.
 *
 * Folded, and populated only when it is opened. A closed foldout costs one line
 * and no network at all, which is right for a panel that most openings of this
 * popup never touch — and the popup has 600px to work with in total.
 */
function sendPanel(keys, net) {
  const asset = el('select', { disabled: true }, [el('option', {}, 'reading balances…')]);
  const to = el('input', { type: 'text', placeholder: 'R… address, i… address, or name@', autocomplete: 'off' });
  const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'amount', autocomplete: 'off' });
  const status = el('div', { class: 'status small' });
  const go = el('button', { type: 'button', disabled: true }, 'review');

  let options = [];

  const keyPicker =
    keys.length > 1
      ? el('select', {}, keys.map((k) => el('option', { value: k.label }, k.label)))
      : null;
  const chosenKey = () => (keyPicker ? keyPicker.value : keys[0].label);

  // A later keystroke must win. `parseDestination` is async — it hashes — so
  // without this a fast typist gets the verdict on a prefix rendered underneath
  // a finished address.
  let seq = 0;
  to.addEventListener('input', async () => {
    const mine = ++seq;
    const text = to.value.trim();
    if (!text) {
      if (mine === seq) mount(status);
      return;
    }
    try {
      const parsed = await parseDestination(text);
      if (mine !== seq) return;
      mount(status, el('span', { class: 'muted' }, parsed.kind === 'name' ? 'an identity — checked when you review' : 'address looks right'));
    } catch (error) {
      if (mine !== seq) return;
      mount(status, el('span', { class: 'danger' }, error.message));
    }
  });

  const node = foldout(
    'send',
    [
      keyPicker ? el('label', {}, 'from') : null,
      keyPicker,
      el('label', {}, 'asset'),
      asset,
      el('label', {}, 'to'),
      to,
      el('label', {}, 'amount'),
      amount,
      el('div', { class: 'buttons' }, [go]),
      status,
    ].filter(Boolean),
  );

  node.addEventListener('toggle', async () => {
    if (!node.open || options.length) return;
    try {
      const label = chosenKey();
      const address = (keys.find((k) => k.label === label) ?? keys[0]).address;
      const own = await currencyBalances(net.node, address);
      const identities = await controlledIdentities(net.node, address);
      const ids = [...new Set([...own, ...identities.flatMap((i) => i.held)].map((h) => h.id))];
      const names = await currencyNames(net.node, ids);

      options = sendables(net, own, identities, names);
      if (options.length === 0) {
        mount(asset, el('option', {}, 'nothing to send'));
        return;
      }
      // Bound by index into a parallel array, never by packing fields into the
      // option's value: a currency name is chain data and anyone can put a
      // separator inside one.
      mount(asset, ...options.map((o, i) => el('option', { value: String(i) }, o.label)));
      asset.disabled = false;
      go.disabled = false;
    } catch (error) {
      mount(status, el('span', { class: 'warn' }, error?.message ?? 'could not read balances'));
    }
  });

  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const choice = options[Number(asset.value)];
      if (!choice) throw new Error('pick something to send');
      await parseDestination(to.value); // the popup's last chance to say why
      const value = amount.value.trim();
      if (!/^\d+(\.\d{1,8})?$/.test(value) || Number(value) <= 0) {
        throw new Error('the amount must be a positive number with at most 8 decimal places');
      }

      // Nothing after this runs. Opening the approval window takes focus from
      // the toolbar popup, which destroys this document mid-promise — so there
      // is no success path to render and no error worth catching except the one
      // that means the window never opened.
      await chrome.runtime.sendMessage({
        type: PORT.LOCAL_REQUEST,
        params: {
          path: choice.path,
          to: to.value.trim(),
          amount: value,
          currency: choice.currency,
          currencyName: choice.currencyName,
          identity: choice.identity,
          keyLabel: chosenKey(),
        },
      });
    } catch (error) {
      mount(status, el('span', { class: 'danger' }, error?.message ?? 'could not start the send'));
      go.disabled = false;
    }
  });

  return node;
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
 * unrecoverable. It is still the right escape hatch, because the alternative
 * is a wizard permanently stuck on a dead step.
 */
function pendingPanel(pending, net) {
  return panel(
    'claims in progress',
    [
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
    ],
  );
}

function networkPicker(net) {
  const select = el(
    'select',
    {
      onchange: async (event) => {
        await setNetwork(event.target.value);
        await render();
      },
    },
    Object.keys(NETWORKS).map((label) => el('option', { value: label, selected: label === net.label }, label)),
  );
  return el('div', {}, [el('label', {}, 'chain'), select]);
}

function keysPanel(keys, net) {
  return panel(
    'keys',
    el(
      'div',
      { class: 'keylist' },
      keys.map((k) => {
        const holdings = el('div', { class: 'holdings muted small' }, 'reading balances…');
        loadHoldings(net, k.address, holdings);

        return el('div', { class: 'keyrow' }, [
          el('div', { class: 'keyrow-head' }, [
            el('div', {}, [el('div', { class: 'accent' }, k.label), el('div', { class: 'addr' }, k.address)]),
            el(
              'button',
              {
                class: 'secondary',
                style: 'flex:0 0 auto;padding:0.1rem 0.4rem;font-size:11px',
                onclick: async () => {
                  // Deleting a key deletes the coins. Ask, every time.
                  if (!confirm(`Remove "${k.label}"? If this key is not backed up elsewhere, its funds are gone.`)) return;
                  await remove(k.label);
                  await render();
                },
              },
              'remove',
            ),
          ]),
          holdings,
        ]);
      }),
    ),
  );
}

/**
 * Every currency at the address, not just the native one.
 *
 * Amounts come from `currencybalance`, which is denominated in COINS — so they
 * go through `coinsShort`, never the SDK's `formatCoins`, which expects
 * satoshis and would render 4.76 dudecoin as 0.00000004.
 */
async function loadHoldings(net, address, container) {
  try {
    const held = await currencyBalances(net.node, address);
    if (held.length === 0) {
      mount(container, el('span', { class: 'muted' }, 'nothing held'));
      return;
    }

    const names = await currencyNames(net.node, held.map((h) => h.id));

    // Native first — it is what fees are paid in — then by size.
    held.sort((a, b) => {
      const an = names.get(a.id) === net.native ? 0 : 1;
      const bn = names.get(b.id) === net.native ? 0 : 1;
      return an - bn || b.amount - a.amount;
    });

    mount(
      container,
      ...held.map((h) =>
        el('div', { class: 'holding' }, [
          el('span', { class: names.get(h.id) === net.native ? 'accent' : 'value' }, names.get(h.id) ?? h.id),
          el('span', { class: 'num' }, coinsShort(h.amount)),
        ]),
      ),
    );

    // Identities are listed separately rather than summed in. What an identity
    // holds is yours to spend, but spending it is a different transaction —
    // funded from the identity's outputs, not the key's — so folding the two
    // together would suggest a single pot that does not exist.
    await appendIdentities(net, address, container);
  } catch (error) {
    mount(container, el('span', { class: 'warn' }, error?.message ?? 'balances unavailable'));
  }
}

async function appendIdentities(net, address, container) {
  const identities = await controlledIdentities(net.node, address);
  if (identities.length === 0) return;

  const ids = [...new Set(identities.flatMap((i) => i.held.map((h) => h.id)))];
  const names = await currencyNames(net.node, ids);

  container.append(
    el('div', { class: 'holdings-head muted small' }, 'held by your identities'),
    ...identities.flatMap((identity) =>
      identity.held.map((h) =>
        el('div', { class: 'holding' }, [
          el('span', { class: 'value' }, [
            names.get(h.id) ?? h.id,
            el('span', { class: 'muted small' }, `  ${identity.name}@`),
          ]),
          el('span', { class: 'num' }, coinsShort(h.amount)),
        ]),
      ),
    ),
  );
}

function createPanel(open = false) {
  const label = el('input', { type: 'text', placeholder: 'label' });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password' });
  const status = el('div', { class: 'status small' });

  const go = el(
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
          await render();
        } catch (error) {
          mount(status, el('span', { class: 'danger' }, error.message));
        }
      },
    },
    'create key',
  );

  return foldout('new key', [label, pass, el('div', { class: 'buttons' }, [go]), status], { open });
}

function importPanel() {
  const wif = el('input', { type: 'password', placeholder: 'WIF', autocomplete: 'off' });
  const label = el('input', { type: 'text', placeholder: 'label' });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password' });
  const status = el('div', { class: 'status small' });

  const go = el(
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
          await render();
        } catch (error) {
          mount(status, el('span', { class: 'danger' }, error.message));
        }
      },
    },
    'import',
  );

  return foldout('import a WIF', [wif, label, pass, el('div', { class: 'buttons' }, [go]), status]);
}

boot().catch((error) => mount(root, el('p', { class: 'danger' }, error?.message ?? String(error))));
