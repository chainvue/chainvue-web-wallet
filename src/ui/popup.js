// Key management and balance. No page can reach any of this.

import init, { Key } from '../vendor/verus-wasm/verus_wasm.js';
import { el, mount, row, panel } from '../lib/dom.js';
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

const root = document.getElementById('root');

async function boot() {
  await init();
  await render();
}

async function render() {
  const net = await currentNetwork();
  const keys = await list();
  const pending = await pendingList(net.label);

  mount(
    root,
    networkPicker(net),
    keys.length ? keysPanel(keys, net) : el('p', { class: 'muted' }, 'no keys yet'),
    pending.length ? pendingPanel(pending, net) : null,
    el('hr'),
    createPanel(),
    importPanel(),
  );
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

function createPanel() {
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

  return panel('new key', [label, pass, el('div', { class: 'buttons' }, [go]), status]);
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

  return panel('import a WIF', [wif, label, pass, el('div', { class: 'buttons' }, [go]), status]);
}

boot().catch((error) => mount(root, el('p', { class: 'danger' }, error?.message ?? String(error))));
