// End-to-end tests for the extension, loaded into a real Chrome.
//
//   npm test
//
// The launchpad site must be served on :8731 for the provider tests. They skip
// themselves if it is not.

import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
// The QR is verified by decoding it, which needs a decoder that shares no code
// with the encoder. Dev-only: nothing in `src/` imports it and it never ships.
import jsQR from 'jsqr';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8731';

/** Launch Chrome with the extension loaded, and find its id. */
async function withExtension(run) {
  const profile = mkdtempSync(join(tmpdir(), 'verus-wallet-'));
  // `channel: 'chromium'` is load-bearing, and two other plausible choices
  // silently fail instead of erroring — in both, the service worker simply
  // never appears:
  //
  //   channel: 'chrome'  — installed Chrome declines unpacked extensions here
  //   no channel         — bundled Chromium's old headless has no extensions
  //
  // 'chromium' is the new headless shell, which does support them.
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;
    await run({ context, extensionId, worker });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Make a key through the real first-run screen.
 *
 * Everything below needs a wallet with a key in it, and every one of them used
 * to inline the same three lines against placeholders. Asking by label instead
 * means the setup screen can be rewritten — as it just was — without touching a
 * dozen tests, and it exercises the label associations while it is there.
 */
async function createKey(page, label, passphrase) {
  await page.getByLabel('Name it').fill(label);
  await page.getByLabel('Passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await expect(page.getByText(label).first()).toBeVisible({ timeout: 15_000 });
}

test('the service worker starts and the wasm module loads in the popup', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    // "no keys yet" only renders after init() resolved, so seeing it proves
    // the 918 KB wasm module instantiated under the extension CSP.
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    expect(errors, errors.join(' | ')).toEqual([]);
  });
});

test('creating a key derives a real R-address and stores it encrypted', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    await createKey(page, 'test-key', 'correct horse battery');

    await expect(page.getByText('test-key')).toBeVisible({ timeout: 15_000 });

    // Read from `data-address`, not from the text: the address is now rendered
    // in groups so it can be checked against a source, and the display string
    // therefore carries separators. The attribute is the real value — which is
    // also what the copy button and any future QR must use.
    const address = await page.locator('[data-address]').first().getAttribute('data-address');
    expect(address).toMatch(/^R[1-9A-HJ-NP-Za-km-z]{25,40}$/);

    // The account row shows the ends only — those are the characters anyone
    // compares against a source, and the row is too tight for all 34. What must
    // hold is that the ends shown are the real ends: an elision that drifted
    // from the underlying value would be worse than no elision at all.
    const shown = (await page.locator('[data-address]').first().textContent()).replace(/\s+/g, '');
    const [head, tail] = shown.split('···');
    expect(head.length, 'an elision that shows nothing is not an elision').toBeGreaterThan(3);
    expect(address.startsWith(head), `${shown} does not begin ${address}`).toBe(true);
    expect(address.endsWith(tail), `${shown} does not end ${address}`).toBe(true);

    const stored = await page.evaluate(() => chrome.storage.local.get('verus-wallet.keys'));
    const envelope = stored['verus-wallet.keys'][0];
    expect(envelope.address).toBe(address);
    expect(envelope.kdf.iterations).toBe(600_000);
    expect(envelope.ciphertext).toBeTruthy();
    expect(envelope.wif).toBeUndefined();
  });
});

test('a sealed envelope does not contain the WIF in clear', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    // Derive a real key, seal it, and look for its actual WIF in the blob that
    // would hit disk. Checking for a stray character class instead would pass
    // on base64 noise and prove nothing.
    const result = await page.evaluate(async () => {
      const wasm = await import('../vendor/verus-wasm/verus_wasm.js');
      await wasm.default();
      const vault = await import('../lib/vault.js');

      const key = wasm.Key.fromEntropy(new Uint8Array(32).fill(7));
      const wif = key.toWif();
      const address = key.address();
      key.free();

      const sealed = await vault.seal('probe', address, wif, 'a passphrase');
      return {
        wif,
        blob: JSON.stringify(sealed),
        recovered: await vault.open(sealed, 'a passphrase'),
      };
    });

    expect(result.wif).toMatch(/^[LKU5][1-9A-HJ-NP-Za-km-z]{50,52}$/);
    expect(result.blob).not.toContain(result.wif);
    expect(result.recovered).toBe(result.wif); // and it still round-trips
  });
});

test('balances cover every currency, and coins are not read as satoshis', async () => {
  // A known testnet address holding VRSCTEST plus two tokens. The bug this
  // guards: `balance` is satoshis and `currencybalance` is COINS, so running
  // the map through the SDK's `formatCoins` renders 4.76 dudecoin as
  // 0.00000004 — and reading only `balance` hides the tokens entirely.
  const ADDRESS = 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU';
  const VRSCTEST = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';

  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const result = await page.evaluate(async (address) => {
      const { rpc, currencyBalances, currentNetwork } = await import('../lib/rpc.js');
      const net = await currentNetwork();
      const raw = await rpc(net.node, 'getaddressbalance', [{ addresses: [address] }]);
      return { raw, held: await currencyBalances(net.node, address) };
    }, ADDRESS);

    test.skip(result.held.length === 0, 'the fixture address has been emptied');

    // The unit invariant, stated as an assertion: the native entry in the map
    // is the satoshi `balance` divided by 1e8. If those two are ever the same
    // scale, this fails and the formatting bug is back.
    const nativeCoins = result.raw.currencybalance[VRSCTEST];
    expect(Math.abs(nativeCoins - result.raw.balance / 1e8)).toBeLessThan(1e-6);

    // And more than the native coin is reported.
    expect(result.held.length).toBeGreaterThan(1);
    expect(result.held.some((h) => h.id !== VRSCTEST)).toBe(true);
  });
});

test('identity-held balances are found, not just the address', async () => {
  // A token's supply is preallocated to its DEFINING IDENTITY, never to the
  // address that paid for the launch. A wallet reading only its own R-address
  // shows nothing and the launch looks like it minted nothing — which is
  // exactly how a real zero-supply launch looks, so the two must be
  // distinguishable.
  const ADDRESS = 'RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3';

  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async (address) => {
      const { controlledIdentities, currencyBalances, currentNetwork } = await import('../lib/rpc.js');
      const net = await currentNetwork();
      return {
        atAddress: await currencyBalances(net.node, address),
        viaIdentities: await controlledIdentities(net.node, address),
      };
    }, ADDRESS);

    test.skip(out.viaIdentities.length === 0, 'this key controls no identity holding anything');

    // Every reported identity actually holds something, and reports its name.
    for (const identity of out.viaIdentities) {
      expect(identity.name, JSON.stringify(identity)).toBeTruthy();
      expect(identity.id).toMatch(/^i[1-9A-HJ-NP-Za-km-z]{25,}$/);
      expect(identity.held.length).toBeGreaterThan(0);
    }

    // And it surfaces at least one holding the address itself does not have —
    // the whole reason the lookup exists.
    const own = new Set(out.atAddress.map((h) => h.id));
    const extra = out.viaIdentities.flatMap((i) => i.held.map((h) => h.id)).filter((id) => !own.has(id));
    expect(extra.length, 'identities should reveal holdings the address lacks').toBeGreaterThan(0);
  });
});

test('coinsShort formats coins, never satoshis', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const { coinsShort, coins } = await import('../lib/fmt.js');
      return {
        token: coinsShort(4.76077049),
        big: coinsShort(109621655.71838312),
        exact: coins(786.9991),
        zero: coinsShort(0),
      };
    });

    expect(out.token).toBe('4.7608');
    expect(out.big).toBe('109,621,655.72');
    expect(out.exact).toBe('786.99910000');
    expect(out.zero).toBe('0');
  });
});

test('a token definition is fixed-supply and cannot be minted', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const { launchDefinition } = await import('./approve.js');
      const { NETWORKS, rpc } = await import('../lib/rpc.js');
      const net = NETWORKS.VRSCTEST;
      const tip = await rpc(net.node, 'getblockcount', []);
      const def = await launchDefinition({ name: 'flop@', supply: '1000', startIn: 1 }, net);
      return { def, tip };
    });

    expect(out.def.kind).toBe('token');
    // 1 is decentralized. 2 would let the defining identity print more forever,
    // which is the single thing that makes a launchpad token worthless.
    expect(out.def.proofProtocol).toBe(1);
    expect(out.def.name).toBe('flop'); // the @ is stripped

    // A token's supply is the SUM OF ITS PREALLOCATIONS. `initialSupply` is
    // read only for a fractional basket — setting it on a token is accepted,
    // burns the 200 fee, and yields a currency with zero supply that can never
    // be fixed, because the defining identity may only define one currency.
    expect(out.def.initialSupply).toBeUndefined();
    expect(out.def.preallocations).toHaveLength(1);
    expect(out.def.preallocations[0].amount).toBe('100000000000'); // 1000 coins
    // The recipient is the identity's i-address, never its friendly name.
    expect(out.def.preallocations[0].recipient).toMatch(/^i[1-9A-HJ-NP-Za-km-z]{25,}$/);

    // A one-block start is legal — the 20 is the daemon RPC's clamp, not consensus.
    expect(out.def.startBlock).toBeGreaterThanOrEqual(out.tip + 1);
    expect(out.def.startBlock).toBeLessThanOrEqual(out.tip + 3);
    expect(out.def.currencies).toBeUndefined();
  });
});

test('the identity gets its @ while the definition name does not', async () => {
  // Two fields, two forms. `planLaunch({identity})` wants the friendly name
  // with its `@`; `CurrencyDefinition.name` wants it bare. Passing the bare
  // one as the identity is refused by the node with
  // `-8: Identity parameter must be valid friendly name or identity address`.
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const { asIdentityRef, launchDefinition } = await import('./approve.js');
      const { NETWORKS } = await import('../lib/rpc.js');
      const def = await launchDefinition({ name: 'launchy', supply: '10', startIn: 1 }, NETWORKS.VRSCTEST);

      let empty = null;
      try {
        asIdentityRef('');
      } catch (e) {
        empty = e.message;
      }

      return {
        bare: asIdentityRef('launchy'),
        already: asIdentityRef('launchy@'),
        // An i-address is already unambiguous and must not be suffixed.
        iaddr: asIdentityRef('iK7UAjSpdPNcwZvhi1UMGt3xGW1tP1JrpZ'),
        defName: def.name,
        empty,
      };
    });

    expect(out.bare).toBe('launchy@');
    expect(out.already).toBe('launchy@');
    expect(out.iaddr).toBe('iK7UAjSpdPNcwZvhi1UMGt3xGW1tP1JrpZ');
    expect(out.defName).toBe('launchy'); // bare, no @
    expect(out.empty).toContain('no identity');
  });
});

test('basket weights sum to exactly one, including when they do not divide', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const { launchDefinition } = await import('./approve.js');
      const { NETWORKS } = await import('../lib/rpc.js');
      const net = NETWORKS.VRSCTEST;
      // Three reserves: 1/3 does not divide evenly into 1e8, so the rounding
      // has to land somewhere. The chain rejects weights that do not sum to 1.
      const three = await launchDefinition(
        { name: 'probe3@', reserves: ['VRSCTEST', 'dudecoin', 'FOOTBALL'], initialSupply: '1000' },
        net,
      );
      const two = await launchDefinition(
        { name: 'probe2@', reserves: ['VRSCTEST', 'dudecoin'], initialSupply: '1000' },
        net,
      );
      let single = null;
      try {
        await launchDefinition({ name: 'probe1@', reserves: ['VRSCTEST'] }, net);
      } catch (e) {
        single = e.message;
      }
      return { three, two, single };
    });

    // Weights are SATOSHIS summing to 100000000 — `"50000000"`, never
    // `"0.50000000"`. The fraction form is refused with
    // `is not a decimal number of satoshis`.
    const sum = (ws) => ws.reduce((t, w) => t + Number(w), 0);
    expect(sum(out.three.weights)).toBe(1e8);
    expect(sum(out.two.weights)).toBe(1e8);
    expect(out.two.weights).toEqual(['50000000', '50000000']);
    // Integers as strings, with no decimal point anywhere.
    for (const w of [...out.three.weights, ...out.two.weights]) {
      expect(w, `weight ${w} must be satoshis, not a fraction`).toMatch(/^\d+$/);
    }
    // Thirds do not divide 1e8; the remainder lands on the last leg.
    expect(out.three.weights).toEqual(['33333333', '33333333', '33333334']);

    expect(out.three.kind).toBe('fractional');
    expect(out.three.currencies).toHaveLength(3);

    // One reserve is a fixed price by construction, so it is refused outright.
    expect(out.single).toContain('at least two reserves');
  });
});

test('a pending registration is stored before anything could be broadcast', async () => {
  // The salt lives only in this blob. Broadcasting a commitment without having
  // saved it spends the registration fee with no way to redeem it.
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const pending = await import('../lib/pending.js');
      await pending.remember('VRSCTEST', 'probe', { pending: 'OPAQUE-SALT-BLOB', commitmentTxid: 'abc' });

      const raw = await chrome.storage.local.get('verus-wallet.pending');
      const recalled = await pending.recall('VRSCTEST', 'probe');
      const wrongChain = await pending.recall('VRSC', 'probe');

      await pending.forget('VRSCTEST', 'probe');
      const afterForget = await pending.recall('VRSCTEST', 'probe');

      return { stored: JSON.stringify(raw), recalled, wrongChain, afterForget };
    });

    expect(out.recalled.pending).toBe('OPAQUE-SALT-BLOB');
    expect(out.stored).toContain('OPAQUE-SALT-BLOB');
    // Keyed per network: a testnet commitment must not be resumed on mainnet,
    // which would spend a second fee.
    expect(out.wrongChain).toBeNull();
    expect(out.afterForget).toBeNull();
  });
});

test('a page can read back a pending commitment, txid and all', async () => {
  // The commitment is invisible on chain until the reveal, so this read is the
  // only way a page can tell "already committed" from "nothing happened".
  await withExtension(async ({ context, extensionId, worker }) => {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(setup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(setup, 'reader', 'correct horse battery');

    // Exactly what phase one writes before it broadcasts.
    await setup.evaluate(async () => {
      const pending = await import('../lib/pending.js');
      await pending.remember('VRSCTEST', 'probename', {
        pending: 'OPAQUE-SALT',
        commitmentTxid: 'deadbeef00000000000000000000000000000000000000000000000000000000',
        registrationFee: '10000000000',
      });
    });

    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);
    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    const seen = await page.evaluate(async () => {
      const hit = await window.verus.request({
        method: 'verus_registrationState',
        params: [{ name: 'probename' }],
      });
      const miss = await window.verus.request({
        method: 'verus_registrationState',
        params: [{ name: 'nothingpending' }],
      });
      return { hit, miss };
    });

    expect(seen.hit.state).toBe('awaitingCommitment');
    expect(seen.hit.commitmentTxid).toBe(
      'deadbeef00000000000000000000000000000000000000000000000000000000',
    );
    expect(seen.miss.state).toBe('none');

    // The salt must never cross the boundary, whatever else does.
    expect(JSON.stringify(seen)).not.toContain('OPAQUE-SALT');
  });
});

test('reading registration state opens no approval window', async () => {
  // It is a read. Prompting for it would make the wizard unusable — it asks on
  // every render.
  await withExtension(async ({ context, extensionId, worker }) => {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(setup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(setup, 'reader', 'correct horse battery');

    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);
    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    const before = (await worker.evaluate(() => chrome.windows.getAll({}))).length;
    await page.evaluate(() =>
      window.verus.request({ method: 'verus_registrationState', params: [{ name: 'anything' }] }),
    );
    const after = (await worker.evaluate(() => chrome.windows.getAll({}))).length;
    expect(after).toBe(before);
  });
});

test('a resumed commitment is handed back as the wrapper, not the inner blob', async () => {
  // `PendingRequest.pending` takes the whole `Pending` object. Passing its
  // inner opaque string instead fails deserialization with
  // "invalid type: string …, expected struct JsPending" — after the
  // registration fee is already spent.
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const { asPending } = await import('./approve.js');

      // The shape saved today.
      const modern = asPending(
        { pending: { state: 'awaitingCommitment', name: 'x', pending: 'INNER', commitmentHex: 'aa' } },
        'x',
      );

      // The shape an earlier build saved: the inner string only. It has a paid
      // fee behind it, so it must still be resumable.
      const legacyBlob = JSON.stringify({ reservation: { name: 'y' }, commitment_hex: 'beef' });
      const legacy = asPending(
        { pending: legacyBlob, commitmentTxid: 'cafe', registrationFee: '10000000000' },
        'y',
      );

      let broken = null;
      try {
        asPending({ pending: 'not json at all' }, 'z');
      } catch (e) {
        broken = e.message;
      }
      return { modern, legacy, broken };
    });

    // Already an object: passed through untouched.
    expect(out.modern.pending).toBe('INNER');
    expect(out.modern.commitmentHex).toBe('aa');

    // Rebuilt, with the hex recovered from the blob and the inner string kept
    // exactly as it was — re-encoding it would invalidate the salt.
    expect(out.legacy.state).toBe('awaitingCommitment');
    expect(out.legacy.name).toBe('y');
    expect(out.legacy.commitmentHex).toBe('beef');
    expect(out.legacy.commitmentTxid).toBe('cafe');
    expect(out.legacy.registrationFee).toBe('10000000000');
    expect(out.legacy.pending).toBe(legacyBlobFor('y'));

    // Unrecoverable says so, rather than failing deep inside wasm.
    expect(out.broken).toContain('older build');
  });

  function legacyBlobFor(name) {
    return JSON.stringify({ reservation: { name }, commitment_hex: 'beef' });
  }
});

test('an absent tokenFunding is omitted, never passed as undefined', async () => {
  // `tokenFunding` is an ARRAY field, and the DTO reader iterates it whenever
  // the key is present — so `{tokenFunding: undefined}` throws
  // `TypeError: Reflect.get called on non-object`, while omitting the key is
  // fine. Scalar options like `via` and `minExpected` tolerate `undefined`,
  // which is why only this one failed and why the distinction is easy to miss.
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const out = await page.evaluate(async () => {
      const wasm = await import('../vendor/verus-wasm/verus_wasm.js');
      await wasm.default();
      const key = wasm.Key.fromEntropy(new Uint8Array(32).fill(3));

      const VRSC = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
      const DUDE = 'iFhnaURhtBLFdtGcTwi5GHxpoSpqjKfWmP';
      const BASK = 'iJkDbbneha35ayVscwcGJCutjCEKQPD8Gm';
      const base = {
        from: VRSC, into: DUDE, kind: 'reserveToReserve', via: BASK,
        amount: '100000000', recipient: key.address(), fee: '20000',
      };

      const attempt = (req) => {
        const a = new wasm.Answers();
        try {
          key.planConvert(req, a);
          return 'ok';
        } catch (e) {
          return String(e.message ?? e);
        } finally {
          a.free();
        }
      };

      const result = {
        omitted: attempt(base),
        undefinedArray: attempt({ ...base, tokenFunding: undefined }),
        undefinedScalar: attempt({ ...base, minExpected: undefined }),
      };
      key.free();
      return result;
    });

    expect(out.omitted).toBe('ok');
    expect(out.undefinedScalar).toBe('ok'); // scalars are tolerated
    // The shape our code must never produce.
    expect(out.undefinedArray).toContain('Reflect.get');
  });
});

test('a stuck claim is visible in the popup and can be discarded', async () => {
  // Without this there is no way out of a dead commitment: the launch page
  // keeps offering "finish claiming" for a name that can never complete, and
  // the record lives only in the wallet.
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    await page.evaluate(async () => {
      const pending = await import('../lib/pending.js');
      await pending.remember('VRSCTEST', 'stuckname', {
        pending: { state: 'awaitingCommitment', name: 'stuckname', pending: 'BLOB' },
        commitmentTxid: 'aabbccddeeff00112233445566778899aabbccddeeff001122334455667788ff',
      });
    });
    await page.reload();

    const claims = page.locator('.panel', { has: page.locator('.panel-title', { hasText: 'claims in progress' }) });
    await expect(claims).toBeVisible({ timeout: 30_000 });
    await expect(claims).toContainText('stuckname@');
    await expect(claims).toContainText('commitment');

    // Discarding is destructive, so it must ask before doing it.
    let asked = '';
    page.on('dialog', (d) => {
      asked = d.message();
      d.accept();
    });
    await claims.getByRole('button', { name: 'discard' }).click();

    await expect(claims).toHaveCount(0, { timeout: 15_000 });
    expect(asked).toContain('cannot be recovered');

    const left = await page.evaluate(async () => {
      const pending = await import('../lib/pending.js');
      return pending.recall('VRSCTEST', 'stuckname');
    });
    expect(left).toBeNull();
  });
});

test('a wrong passphrase cannot open the envelope', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const result = await page.evaluate(async () => {
      const vault = await import('../lib/vault.js');
      const sealed = await vault.seal('k', 'Raddr', 'UwifSecretValue', 'right passphrase');
      const good = await vault.open(sealed, 'right passphrase');
      let bad = null;
      try {
        await vault.open(sealed, 'wrong passphrase');
      } catch (e) {
        bad = e.message;
      }
      return { good, bad };
    });

    expect(result.good).toBe('UwifSecretValue');
    expect(result.bad).toBe('wrong passphrase');
  });
});

test('window.verus is injected into a page and refuses unknown methods', async () => {
  await withExtension(async ({ context }) => {
    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE} — run its server first`);

    await expect.poll(() => page.evaluate(() => Boolean(window.verus?.isVerusWallet)), {
      timeout: 15_000,
    }).toBe(true);

    // An unsupported method must be refused by the wallet, not silently ignored.
    const refused = await page.evaluate(async () => {
      try {
        await window.verus.request({ method: 'verus_stealEverything', params: [] });
        return null;
      } catch (e) {
        return { code: e.code, message: e.message };
      }
    });
    expect(refused.code).toBe(4200);
    expect(refused.message).toContain('unsupported method');
  });
});

test('the provider exposes no way to read a key', async () => {
  await withExtension(async ({ context }) => {
    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);

    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    const surface = await page.evaluate(() => ({
      keys: Object.keys(window.verus),
      frozen: Object.isFrozen(window.verus),
      writable: (() => {
        try {
          window.verus = { hijacked: true };
          return window.verus.hijacked === true;
        } catch {
          return false;
        }
      })(),
    }));

    expect(surface.keys.sort()).toEqual(['isVerusWallet', 'request']);
    expect(surface.frozen).toBe(true);
    expect(surface.writable).toBe(false);
  });
});

test('the launchpad wizard reaches the wallet instead of reporting none', async () => {
  // The two repos only meet at `window.verus`. This is the test that they do.
  await withExtension(async ({ context, extensionId, worker }) => {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(setup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(setup, 'wizard', 'correct horse battery');

    const page = await context.newPage();
    const response = await page.goto(`${SITE}/launch.html`).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);

    await page.locator('input[placeholder="mycoin"]').fill('zzznotaname');
    await page.getByRole('button', { name: 'check' }).click();

    const act = page.getByRole('button', { name: 'claim zzznotaname@' });
    await expect(act).toBeVisible({ timeout: 30_000 });

    const before = new Set(await worker.evaluate(async () => (await chrome.windows.getAll({})).map((w) => w.id)));
    await act.click();

    // With a wallet present it must open an approval, not say there is none.
    await expect
      .poll(
        async () =>
          worker.evaluate(
            async (known) => (await chrome.windows.getAll({})).some((w) => !known.includes(w.id)),
            [...before],
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect(page.locator('.status')).not.toContainText('no wallet');
  });
});

test('the approval window opens as a small popup, not fullscreen', async () => {
  // On macOS an unpositioned `windows.create` inherits the parent's fullscreen
  // space, so the wallet appears to take over the screen. Explicit bounds plus
  // `state: 'normal'` is the fix; this checks the window that actually opens.
  await withExtension(async ({ context, extensionId, worker }) => {
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(setup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    // A key must exist or the request is refused before any window opens.
    await createKey(setup, 'approver', 'correct horse battery');

    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);
    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    // Snapshot what exists first. Playwright's own pages also report as
    // `type: "popup"`, so the approval window can only be identified as the
    // one that was not there before.
    const before = new Set(await worker.evaluate(async () => (await chrome.windows.getAll({})).map((w) => w.id)));

    await page.evaluate(() => {
      // Deliberately not awaited: it stays pending until the window answers.
      window.verus
        .request({
          method: 'verus_convert',
          params: [{ from: 'VRSCTEST', into: 'dudecoin', via: 'dudebasket', kind: 'reserveToReserve', amount: '1' }],
        })
        .catch(() => {});
    });

    // Observed through the service worker, not as a Playwright page: Chrome
    // really does create the window in headless, but Playwright does not
    // surface extension popup windows as pages, so `waitForEvent('page')`
    // waits forever on a window that exists.
    // Identified by being new, not by tab URL: reading `tab.url` needs the
    // "tabs" permission, which this extension deliberately does not request.
    const findPopup = () =>
      worker.evaluate(async (known) => {
        const windows = await chrome.windows.getAll({});
        const found = windows.find((w) => !known.includes(w.id));
        return found ? { width: found.width, height: found.height, state: found.state, type: found.type } : null;
      }, [...before]);

    await expect.poll(findPopup, { timeout: 20_000 }).not.toBeNull();
    const popup = await findPopup();

    expect(popup.type).toBe('popup');
    // The assertion that matters for the reported bug: `state: "normal"` is
    // what stops macOS opening the approval as its own fullscreen space.
    expect(popup.state, 'must not inherit the parent fullscreen space').toBe('normal');

    // Pixel size is deliberately NOT asserted. Headless Chrome ignores both
    // the creation size and a follow-up `windows.update` on this path — it
    // reports the parent's dimensions regardless — while a direct
    // `windows.create` in the same browser honours them. That makes any
    // width assertion here a test of headless quirks, not of this code.
    // Whether the popup is 400px wide has to be confirmed by looking at it.
  });
});

test('a launch request with no key is refused before any window opens', async () => {
  await withExtension(async ({ context }) => {
    const page = await context.newPage();
    const response = await page.goto(SITE).catch(() => null);
    test.skip(!response, `no launchpad site on ${SITE}`);

    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    const before = context.pages().length;
    const refused = await page.evaluate(async () => {
      try {
        await window.verus.request({
          method: 'verus_launchCurrency',
          params: [{ chain: 'VRSCTEST', name: 'x@', reserves: ['VRSCTEST', 'y'], initialSupply: 1000 }],
        });
        return null;
      } catch (e) {
        return { code: e.code, message: e.message };
      }
    });

    expect(refused.code).toBe(4100);
    expect(refused.message).toContain('no key in the wallet');
    expect(context.pages().length, 'no approval window should have opened').toBe(before);
  });
});

test('the toolbar popup fits inside Chrome without scrolling', async () => {
  // Chrome caps a browser-action popup at 600px tall and scrolls past that.
  // The popup rendered 735px because it drew the create-key and import-key
  // forms unconditionally — 426px of one-time setup in front of the balance,
  // every time it was opened. Both are folded away once a key exists.
  //
  // Measured at the real 360px width, since content height depends on wrapping.
  const CHROME_POPUP_MAX = 600;

  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    // Tall viewport so the measurement is the CONTENT, not the window: an
    // element's height cannot be read past the bottom of a short one.
    await popup.setViewportSize({ width: 360, height: 3000 });
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const height = () => popup.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));

    // First run: setup has to be reachable without hunting for it, so the form
    // is simply there — no longer folded away behind a disclosure at all. It
    // still has to fit.
    const fresh = await height();
    expect(fresh, `first run renders ${fresh}px`).toBeLessThan(CHROME_POPUP_MAX);
    await expect(popup.getByLabel('Name it')).toBeVisible();
    await expect(popup.getByLabel('Passphrase')).toBeVisible();
    // And it says what the passphrase is, where the decision is made, rather
    // than in a README nobody has open at this moment.
    await expect(popup.getByText(/cannot be reset/i)).toBeVisible();

    await createKey(popup, 'probe', 'correct horse battery');

    // Once there is a key, the everyday view is the balance — setup folds away
    // and must not be occupying the window any more.
    //
    // Asserted as "the setup fields are not on screen" rather than as "shorter
    // than first run". The height comparison was only ever a proxy for this,
    // and it was the wrong one: it also forbids the everyday view from ever
    // gaining a row, which the send panel legitimately does. What the original
    // bug was about is 426px of one-time setup standing in front of the
    // balance, and that is what this checks.
    const settled = await height();
    expect(settled, `with a key renders ${settled}px`).toBeLessThan(CHROME_POPUP_MAX);
    // None visible, rather than the first — both the create and the import form
    // carry a "label" field and both have to be out of the way.
    expect(await popup.locator('input[placeholder="WIF"]:visible').count()).toBe(0);
    expect(await popup.locator('input[placeholder="label"]:visible').count()).toBe(0);

    // Moved rather than deleted: setup and anything destructive now live behind
    // "Manage keys" instead of stacked under the balance.
    await popup.getByRole('button', { name: /Manage keys/ }).click();
    await popup.getByText('import a WIF').click();
    await expect(popup.locator('input[placeholder="WIF"]')).toBeVisible();
    for (const fold of await popup.locator('details.foldout').all()) {
      expect(await fold.getAttribute('open'), 'only the one just opened').not.toBe(undefined);
    }
  });
});

test('a loaded popup does not overflow its width', async () => {
  // Chrome sizes a toolbar popup to its content, and the window is on screen
  // before the content is finished — wasm has to instantiate, then balances are
  // fetched per key. So a row that cannot shrink widens the WINDOW a moment
  // after it opened, and because the popup hangs off the toolbar icon at the
  // top right, it grows leftwards. It reads as the wallet sliding sideways.
  //
  // The cause is that a flex child defaults to `min-width: auto` and so refuses
  // to shrink below its longest unbreakable run. A currency id is 34 characters
  // with nothing to break on, and `currencyNames` falls back to the raw id
  // whenever a lookup fails — so one unresolved name did it.
  //
  // The height test above measures an empty wallet and a bare key. Neither has
  // holdings, because holdings arrive asynchronously, which is exactly why this
  // went unnoticed: the state that breaks is the state that takes longest to
  // appear. This one renders holdings directly rather than waiting on a node.
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 900 });
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const measured = await popup.evaluate(async () => {
      const { el, mount, panel } = await import('../lib/dom.js');
      const UNRESOLVED = 'iFhnaURhtBLFdtGcTwi5GHxpoSpqjKfWmP';
      const holding = (label, amount) =>
        el('div', { class: 'holding' }, [
          el('span', { class: 'value' }, label),
          el('span', { class: 'num' }, amount),
        ]);

      mount(
        document.getElementById('root'),
        panel(
          'keys',
          el('div', { class: 'keylist' }, [
            el('div', { class: 'keyrow' }, [
              el('div', { class: 'keyrow-head' }, [
                el('div', {}, [
                  // A label is whatever the user typed, and they can type a lot.
                  el('div', { class: 'accent' }, 'a-very-long-key-label-someone-typed'),
                  el('div', { class: 'addr' }, 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU'),
                ]),
                el('button', { class: 'secondary' }, 'remove'),
              ]),
              el('div', { class: 'holdings muted small' }, [
                holding('VRSCTEST', '786.99'),
                holding(UNRESOLVED, '1,234.5678'),
                el('div', { class: 'holdings-head muted small' }, 'held by your identities'),
                holding(
                  [UNRESOLVED, el('span', { class: 'muted small' }, '  launchy-basket@')],
                  '1,000,000,000',
                ),
              ]),
            ]),
          ]),
        ),
      );

      const overflow = (node) => node.scrollWidth - Math.ceil(node.getBoundingClientRect().width);
      return {
        documentWidth: document.documentElement.scrollWidth,
        worstRow: Math.max(...[...document.querySelectorAll('.holding')].map(overflow)),
        worstHead: Math.max(...[...document.querySelectorAll('.keyrow-head')].map(overflow)),
      };
    });

    // Measured at 33px of overflow before the fix.
    expect(measured.worstRow, 'a holdings row overflows its panel').toBeLessThanOrEqual(0);
    expect(measured.worstHead, 'the key label overflows its row').toBeLessThanOrEqual(0);
    expect(measured.documentWidth, 'the document is wider than the popup').toBe(360);
  });
});

// --- destinations ----------------------------------------------------------
//
// These run entirely in the page, against the real module, and touch no node.
// `src/lib/address.js` is the only thing standing between a mistyped character
// and coins paid to a hash nobody holds the key for, so it is tested first and
// hardest.

/** Addresses whose checksums were verified by decoding them, not by assumption. */
const REAL = {
  transparent: ['RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', 'RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3'],
  identity: ['iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', 'iFhnaURhtBLFdtGcTwi5GHxpoSpqjKfWmP'],
};

/** Open the popup only to get a document that can import the extension's modules. */
async function inPage(context, extensionId, fn, arg) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
  await expect(page.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(fn, arg);
}

test('a real address is classified and a one-character typo is refused', async () => {
  // The whole argument for base58check over a prefix-and-length regex: a typo
  // keeps the prefix and keeps the length. Every one of these mutants would
  // pass /^[Ri][1-9A-HJ-NP-Za-km-z]{33}$/ and pay a stranger.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(
      context,
      extensionId,
      async (fixtures) => {
        const { parseDestination, KIND } = await import('../lib/address.js');
        const attempt = async (text) => {
          try {
            return { ok: true, ...(await parseDestination(text)) };
          } catch (error) {
            return { ok: false, message: error.message };
          }
        };

        const good = [];
        const mutated = [];
        for (const [kind, list] of Object.entries(fixtures)) {
          for (const address of list) {
            good.push({ kind, address, got: await attempt(address) });
            // Flip one character, somewhere in the middle, to another that is
            // in the alphabet — so only the checksum can object.
            const at = 12;
            const swap = address[at] === 'x' ? 'y' : 'x';
            const typo = address.slice(0, at) + swap + address.slice(at + 1);
            mutated.push({ typo, length: typo.length, got: await attempt(typo) });
          }
        }
        return { good, mutated, KIND };
      },
      REAL,
    );

    for (const entry of out.good) {
      expect(entry.got.ok, `${entry.address} → ${entry.got.message}`).toBe(true);
      expect(entry.got.kind, entry.address).toBe(out.KIND[entry.kind === 'transparent' ? 'TRANSPARENT' : 'IDENTITY']);
      expect(entry.got.to).toBe(entry.address);
    }

    for (const entry of out.mutated) {
      expect(entry.got.ok, `a typo was accepted: ${entry.typo}`).toBe(false);
      // Named, not merely refused. "invalid address" is what the SDK would say
      // far too late; this has to tell someone what to do about it.
      expect(entry.got.message, entry.typo).toMatch(/typo|checksum/i);
    }
  });
});

test('a shielded address is refused for the real reason, not as a bad checksum', async () => {
  // The SDK has no shielded support at all — `Key.fromSeedPhrase` derives a
  // transparent key and there is simply no other kind. A `zc…` Sprout address
  // is itself valid base58check, so if the z check ran after the decode this
  // would come back as an unknown version byte and tell the user nothing.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { parseDestination } = await import('../lib/address.js');
      const results = {};
      for (const z of ['zs1w9k8fmelt3cjqyxv6ug2vzcsyxfz7yxr8', 'ztestsapling1abcdefghijkmnop', 'zcRGmkC9nR2SCbpo']) {
        try {
          await parseDestination(z);
          results[z] = 'ACCEPTED';
        } catch (error) {
          results[z] = error.message;
        }
      }
      return results;
    });

    for (const [address, message] of Object.entries(out)) {
      expect(message, address).toMatch(/shielded/i);
      expect(message, `${address} blamed the checksum instead of saying why`).not.toMatch(/checksum|typo/i);
    }
  });
});

test('a bare name is not silently turned into an identity', async () => {
  // `asIdentityRef` turns any string into `thing@`, which is correct where the
  // caller already knows it named an identity. In a send box it would mean a
  // mistyped address quietly becomes a payment to a completely different place.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { parseDestination, KIND } = await import('../lib/address.js');
      const attempt = async (text) => {
        try {
          return { ok: true, ...(await parseDestination(text)) };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      };
      return {
        bare: await attempt('alice'),
        withAt: await attempt('alice@'),
        empty: await attempt('   '),
        junk: await attempt('not an address'),
        NAME: KIND.NAME,
      };
    });

    expect(out.bare.ok, 'a bare name was accepted').toBe(false);
    expect(out.bare.message).toMatch(/alice@/);

    expect(out.withAt.ok, out.withAt.message).toBe(true);
    expect(out.withAt.kind).toBe(out.NAME);
    expect(out.withAt.to).toBe('alice@');

    expect(out.empty.ok).toBe(false);
    expect(out.junk.ok).toBe(false);
  });
});

test('the page-facing surface has not grown a way to send', async () => {
  // A canary, and the cheapest test in this file. Sending is the only thing the
  // wallet does that pays a destination somebody else chose, so it is kept off
  // the page allowlist entirely. This fails the moment anyone adds it there
  // "for symmetry".
  await withExtension(async ({ context, extensionId }) => {
    const methods = await inPage(context, extensionId, async () => {
      const { PAGE_METHODS } = await import('../lib/protocol.js');
      return Object.values(PAGE_METHODS).sort();
    });

    expect(methods).toEqual(
      [
        'verus_connect',
        'verus_address',
        'verus_registerIdentity',
        'verus_registrationState',
        'verus_sendTokenFromIdentity',
        'verus_launchCurrency',
        'verus_convert',
      ].sort(),
    );
  });
});

test('only the wallet popup can start a send', async () => {
  // The content script this extension injects into every page is the only
  // forger within reach — a page cannot call chrome.runtime.sendMessage at all,
  // since no externally_connectable is declared. A content script's sender
  // always carries a tab and the page's own origin, which is what is checked.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(
      context,
      extensionId,
      async (id) => {
        const { assertPopupSender } = await import('../lib/protocol.js');
        const own = `chrome-extension://${id}`;
        const attempt = (sender) => {
          try {
            assertPopupSender(sender, id);
            return 'ACCEPTED';
          } catch (error) {
            return error.message;
          }
        };

        return {
          realPopup: attempt({ id, origin: own, url: `${own}/src/ui/popup.html` }),
          // The popup opened as an ordinary tab, which a user can do and which
          // is how this path is tested. Allowed on purpose: it is still this
          // extension's own popup document.
          popupInATab: attempt({ id, tab: { id: 3 }, origin: own, url: `${own}/src/ui/popup.html` }),
          contentScript: attempt({ id, tab: { id: 7 }, origin: 'https://evil.test', url: 'https://evil.test/' }),
          // A content script that has somehow lost its tab still carries the
          // page's origin.
          pageOrigin: attempt({ id, origin: 'https://evil.test', url: 'https://evil.test/' }),
          otherExtension: attempt({ id: 'aaaabbbbccccddddeeeeffffgggghhhh', origin: own, url: `${own}/src/ui/popup.html` }),
          // Our own extension, but not the popup — the approval window must not
          // be able to start a second send either.
          otherPage: attempt({ id, origin: own, url: `${own}/src/ui/approve.html?id=1` }),
          nothing: attempt(undefined),
        };
      },
      extensionId,
    );

    const allowed = new Set(['realPopup', 'popupInATab']);
    for (const [name, verdict] of Object.entries(out)) {
      if (allowed.has(name)) expect(verdict, `${name} was refused`).toBe('ACCEPTED');
      else expect(verdict, `${name} was accepted`).not.toBe('ACCEPTED');
    }
  });
});

test('a malformed send is refused before it reaches the worker', async () => {
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { sanitiseLocalSend, SEND_PATH } = await import('../lib/protocol.js');
      const attempt = (raw) => {
        try {
          return { ok: true, value: sanitiseLocalSend(raw) };
        } catch (error) {
          return { ok: false, message: error.message };
        }
      };
      const good = { path: SEND_PATH.NATIVE, to: 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', amount: '1.5' };
      return {
        good: attempt(good),
        nineDecimals: attempt({ ...good, amount: '1.123456789' }),
        zero: attempt({ ...good, amount: '0' }),
        negative: attempt({ ...good, amount: '-1' }),
        words: attempt({ ...good, amount: 'all of it' }),
        noPath: attempt({ ...good, path: 'nonsense' }),
        tokenWithoutCurrency: attempt({ ...good, path: SEND_PATH.TOKEN }),
        tokenWithName: attempt({ ...good, path: SEND_PATH.TOKEN, currency: 'dudecoin' }),
      };
    });

    expect(out.good.ok, out.good.message).toBe(true);
    // A string all the way down: parsed as a float, the eighth decimal place is
    // a whole satoshi.
    expect(out.good.value.amount).toBe('1.5');

    for (const name of ['nineDecimals', 'zero', 'negative', 'words', 'noPath', 'tokenWithoutCurrency', 'tokenWithName']) {
      expect(out[name].ok, `${name} was accepted`).toBe(false);
    }
    expect(out.nineDecimals.message).toMatch(/8 decimal/);
  });
});

// --- the Receive QR --------------------------------------------------------
//
// A QR code that is subtly wrong does not look wrong. It scans, cleanly, to an
// address nobody holds the key for — so "it renders" is not evidence of
// anything, and neither is reading the encoder's source. The only proof that
// counts is putting the drawn pixels through a decoder that shares no code with
// the encoder and seeing the address come back out.

test('the QR on Receive decodes back to the exact address', async () => {
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 1200 });
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    await createKey(popup, 'probe', 'correct horse battery');

    await popup.getByRole('button', { name: /Receive/ }).click();
    const canvas = popup.locator('.qr canvas');
    await expect(canvas).toBeVisible();

    // The address as the wallet stores it, read from the grouped element's
    // `data-address` so the spaces the display adds cannot creep into the
    // comparison.
    const address = await popup.locator('.receive-addr [data-address]').getAttribute('data-address');
    expect(address).toMatch(/^R[1-9A-HJ-NP-Za-km-z]{33}$/);

    const shot = await popup.evaluate(() => {
      const node = document.querySelector('.qr canvas');
      const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height);
      return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) };
    });

    const decoded = jsQR(new Uint8ClampedArray(shot.data), shot.width, shot.height);
    expect(decoded, 'the rendered QR could not be decoded at all').not.toBeNull();
    expect(decoded.data, 'the QR decodes to something other than the address').toBe(address);

    // Not a formality: a matrix drawn transposed still decodes, to something
    // else, and both of those would pass a "does it produce a QR" check.
    expect(decoded.data).not.toBe('');
  });
});

// --- activity --------------------------------------------------------------

test('activity carries confirmations and who was on the other end', async () => {
  // Against the live chain and a real address with history, because the whole
  // point of these fields is that they come from a node — a fixture would only
  // prove the shape of the fixture.
  const HAS_HISTORY = 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU';

  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(
      context,
      extensionId,
      async (address) => {
        const { NETWORKS, recentActivity, counterparty } = await import('../lib/rpc.js');
        const net = NETWORKS.VRSCTEST;
        const rows = await recentActivity(net.node, address, 3);
        const other = rows.length ? await counterparty(net.node, rows[0].txid, address) : null;
        return { rows, other, explorer: net.explorerTx };
      },
      HAS_HISTORY,
    );

    expect(out.rows.length, 'this address has history on testnet').toBeGreaterThan(0);

    for (const row of out.rows) {
      expect(row.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(['in', 'out']).toContain(row.direction);
      expect(row.coins).toBeGreaterThan(0);
      expect(typeof row.pending).toBe('boolean');
      // Deep history, so every row is settled and must say so with a real count
      // rather than the zero that means "not confirmed yet".
      expect(row.confirmations, `${row.txid} reports ${row.confirmations} confirmations`).toBeGreaterThan(0);
    }

    // Never this address itself: the rule that excludes change is "not ours",
    // so its own address appearing on either side would mean the filter is off.
    const named = [...out.other.paid, ...out.other.paidBy];
    expect(named, 'no counterparty was found for a transaction with inputs and outputs').not.toHaveLength(0);
    expect(named).not.toContain(HAS_HISTORY);

    expect(out.explorer).toContain('#/tx/');
  });
});

// --- recent recipients -----------------------------------------------------

test('a paid destination is remembered per chain, and can be cleared', async () => {
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { list, remember, clear } = await import('../lib/recipients.js');

      await remember('VRSCTEST', 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU');
      await remember('VRSCTEST', 'alice@');
      await remember('VRSC', 'RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3');
      const afterThree = await list('VRSCTEST');

      // Paying somebody again moves them to the front instead of listing them
      // twice — it is a list of people, not a log of payments.
      await remember('VRSCTEST', 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU');
      const afterRepeat = await list('VRSCTEST');

      await clear('VRSCTEST');
      return {
        afterThree,
        afterRepeat,
        cleared: await list('VRSCTEST'),
        otherChain: await list('VRSC'),
        empty: await list('VRSCTEST'),
      };
    });

    expect(out.afterThree).toEqual(['alice@', 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU']);
    expect(out.afterRepeat).toEqual(['RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', 'alice@']);
    expect(out.cleared).toEqual([]);
    // Clearing one chain must not take the other with it: they are separate
    // lists because they are separate sets of people.
    expect(out.otherChain).toEqual(['RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3']);
  });
});

// --- announced, not merely drawn -------------------------------------------

test('everything the wallet reports is inside a live region', async () => {
  // The failure this prevents is silent by construction: the interface looks
  // finished, and somebody using a screen reader gets no confirmation that their
  // money moved. Every line the wallet talks through is checked, not sampled.
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    const firstRun = await popup.locator('.status:not([role="status"])').count();
    expect(firstRun, 'a status line on the first-run screen is not announced').toBe(0);

    await createKey(popup, 'probe', 'correct horse battery');

    // The balance is the answer to the question the wallet was opened to ask,
    // and it arrives after the document does.
    await expect(popup.locator('.balance')).toHaveAttribute('role', 'status');

    await popup.getByRole('button', { name: /Send/ }).click();
    expect(await popup.locator('.status:not([role="status"])').count()).toBe(0);
    // The verdict on a destination has to reach the field it is about.
    const describedBy = await popup.locator('input[placeholder*="address"]').getAttribute('aria-describedby');
    expect(describedBy).toBe('to-help');
    await expect(popup.locator('#to-help')).toHaveAttribute('aria-live', 'polite');
  });
});

// --- what a balance is worth -----------------------------------------------

test('the price comes from the basket and agrees with an actual quote', async () => {
  // The whole risk in pricing from reserve state is getting the ratio the wrong
  // way up. Inverted, 0.537 becomes 1.86 — still a plausible-looking number, on
  // a screen where nobody has anything to check it against.
  //
  // So it is checked against the one thing that can contradict it:
  // `estimateconversion`, which is a different code path in the daemon and
  // answers what the conversion would actually pay. The two must agree to
  // within the conversion fee; inverted they differ by more than threefold.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { NETWORKS, rpc } = await import('../lib/rpc.js');
      const { priceBook, UNIT_LABEL } = await import('../lib/price.js');
      const { value } = await import('../lib/fmt.js');
      const net = NETWORKS.VRSCTEST;

      const book = await priceBook(net.node);
      const native = await rpc(net.node, 'getcurrency', [net.native]);
      const quote = await rpc(net.node, 'estimateconversion', [
        { currency: net.native, convertto: 'DAI.vETH', via: 'bridge.veth', amount: 1 },
      ]);

      return {
        unit: UNIT_LABEL,
        priced: [...book.keys()],
        nativeId: native.currencyid,
        mid: book.get(native.currencyid) ?? null,
        quoted: quote?.estimatedcurrencyout ?? null,
        formatted: [value(60.0449), value(0.0004), value(0), value(12345.678), value(-1), value('x')],
      };
    });

    expect(out.unit).toBe('DAI');
    expect(out.priced.length, 'the basket priced nothing').toBeGreaterThanOrEqual(4);
    expect(out.mid, 'the native coin has no price').toBeGreaterThan(0);
    expect(out.quoted, 'the node would not quote the conversion').toBeGreaterThan(0);

    // Within 5%. The gap is the conversion fee, and it is nowhere near the
    // factor of 1/x² that an inverted ratio would produce.
    const drift = Math.abs(out.mid - out.quoted) / out.quoted;
    expect(drift, `mid ${out.mid} against quote ${out.quoted}`).toBeLessThan(0.05);

    // Two decimals for a price; more only below a cent, where rounding to 0.00
    // would say a holding is worth nothing. Never a number for nonsense.
    expect(out.formatted).toEqual(['60.04', '0.0004', '0.00', '12,345.68', null, null]);
  });
});

test('an unpriceable holding shows no value rather than a wrong one', async () => {
  // Anybody can define a currency on Verus, and most of them have no route to
  // the basket. The measured case was sixteen holdings with one price. The rule
  // is that the wallet says nothing about the other fifteen — the failure worth
  // preventing is a confident zero.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { NETWORKS } = await import('../lib/rpc.js');
      const { priceBook } = await import('../lib/price.js');
      const book = await priceBook(NETWORKS.VRSCTEST.node);
      // A currency id that is real, held by the test address, and not a reserve
      // of bridge.vETH.
      const INVENTED = 'iFhnaURhtBLFdtGcTwi5GHxpoSpqjKfWmP';
      return { known: book.size, unpriced: book.has(INVENTED), zero: book.get(INVENTED) };
    });

    expect(out.known).toBeGreaterThan(0);
    expect(out.unpriced, 'a currency outside the basket must not get a price').toBe(false);
    // Not 0 — `undefined`. A zero would render as "≈ 0.00" and claim the
    // holding is worthless.
    expect(out.zero).toBeUndefined();
  });
});

// --- owning a wallet -------------------------------------------------------
//
// Three defects that were not interface problems: a key that could not be
// backed up, a second account that could not be reached, and real money dressed
// identically to play money.

test('a key can be backed up, and what comes out is the key', async () => {
  // "It printed a string" proves nothing — the failure that matters here is a
  // reveal that shows the wrong key, or a mangled one, which would look
  // completely fine and would be discovered only by someone trying to restore
  // from it. So the revealed WIF is fed back through the SDK and the address it
  // derives is compared to the address the wallet has been showing.
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 1400 });
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(popup, 'savings', 'correct horse battery');

    const shown = await popup.locator('.acct-addr [data-address]').getAttribute('data-address');
    expect(shown).toMatch(/^R[1-9A-HJ-NP-Za-km-z]{33}$/);

    await popup.getByRole('button', { name: /Manage keys/ }).click();
    await popup.getByRole('button', { name: 'Back up' }).click();

    // A wrong passphrase must not reveal anything, and must not be reported in
    // a way that says how close it was.
    await popup.locator('.reveal input[type=password]').fill('not the passphrase');
    await popup.getByRole('button', { name: 'Reveal' }).click();
    await expect(popup.locator('.reveal .status')).toContainText(/wrong passphrase/i);
    expect(await popup.locator('.secret').count(), 'a wrong passphrase revealed something').toBe(0);

    await popup.locator('.reveal input[type=password]').fill('correct horse battery');
    await popup.getByRole('button', { name: 'Reveal' }).click();
    const wif = (await popup.locator('.secret').textContent({ timeout: 15_000 })).trim();
    expect(wif.length).toBeGreaterThan(40);

    const derived = await popup.evaluate(async (text) => {
      const { default: init, Key } = await import('../vendor/verus-wasm/verus_wasm.js');
      await init();
      const key = Key.fromWif(text);
      try {
        return key.address();
      } finally {
        key.free();
      }
    }, wif);

    expect(derived, 'the revealed key does not derive the address it was shown for').toBe(shown);

    // And the warning is where the decision is, not in a README.
    await expect(popup.getByText(/Anyone who reads this owns the coins/i)).toBeVisible();
  });
});

test('a second key is reachable, which it was not', async () => {
  // The regression this locks down: `view.key` was only ever assigned at
  // creation, at import, or defaulted to the key already showing — so home was
  // pinned to whichever key was added last, and the other one could be created,
  // stored, and then never displayed again.
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 1400 });
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    await createKey(popup, 'savings', 'correct horse battery');
    const first = await popup.locator('.acct-addr [data-address]').getAttribute('data-address');

    await popup.getByRole('button', { name: /Manage keys/ }).click();
    await popup.getByText('new key').click();
    await popup.locator('input[placeholder="label"]').first().fill('spending');
    await popup.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await popup.getByRole('button', { name: 'create key' }).click();
    await expect(popup.getByText('spending').first()).toBeVisible({ timeout: 15_000 });

    // Home now shows the newest key — which is the state that used to be
    // permanent.
    const second = await popup.locator('.acct-addr [data-address]').getAttribute('data-address');
    expect(second).not.toBe(first);

    await popup.getByRole('button', { name: /Change account/ }).click();
    await popup.getByRole('button', { name: /savings/ }).click();

    await expect
      .poll(async () => popup.locator('.acct-addr [data-address]').first().getAttribute('data-address'))
      .toBe(first);
  });
});

test('mainnet does not look like testnet', async () => {
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    // Every token a person actually sees, read off computed style rather than
    // off the stylesheet. The first version of this test checked only the body
    // background and passed while the interface was still green: fifteen greens
    // were baked into rules instead of tokens, so the frames changed chain and
    // the wallet did not. Sampling one property is how that got through.
    const dress = () =>
      popup.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const token = (name) => root.getPropertyValue(name).trim();
        return {
          chain: document.documentElement.getAttribute('data-chain'),
          rail: document.querySelector('.chain-rail')?.textContent ?? null,
          ground: getComputedStyle(document.body).backgroundColor,
          // What the chain is allowed to change.
          chainful: [
            'accent', 'value', 'frame', 'title', 'muted', 'bg', 'bg-panel',
            'hair', 'hair-dot', 'tint', 'tint-strong', 'dot-token',
            'avatar-from', 'skel-a', 'skel-b', 'skel-flat',
          ].map((n) => token(`--${n}`)),
          // What it must not: destruction, warnings, and the pair that says
          // whether you or a website started this.
          semantic: ['danger', 'warn', 'prov-local', 'prov-site'].map((n) => token(`--${n}`)),
        };
      });

    const test = await dress();
    expect(test.chain).toBe('test');
    expect(test.rail, 'testnet must not carry a real-funds rail').toBeNull();

    // The confirmation is one-way and this is the direction that asks.
    popup.once('dialog', (d) => {
      expect(d.message()).toMatch(/real VRSC/i);
      d.accept();
    });
    await popup.locator('select.chip').selectOption('VRSC');

    await expect.poll(async () => (await dress()).chain).toBe('real');
    const main = await dress();
    expect(main.rail).toMatch(/real funds/i);
    expect(main.ground, 'the two chains render the same ground').not.toBe(test.ground);

    // Not "some of it differs" — every single one, or a token was left behind.
    const stayed = main.chainful
      .map((value, i) => (value === test.chainful[i] ? i : null))
      .filter((i) => i !== null);
    expect(stayed, `${stayed.length} chain token(s) did not change`).toEqual([]);

    // And the meanings that have to survive a change of chain did.
    expect(main.semantic, 'a semantic colour moved with the chain').toEqual(test.semantic);
  });
});

test('switching back to testnet does not ask', async () => {
  // A prompt that appears in both directions is one people learn to dismiss
  // without reading, which costs more than it buys.
  await withExtension(async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });

    popup.once('dialog', (d) => d.accept());
    await popup.locator('select.chip').selectOption('VRSC');
    await expect.poll(() => popup.evaluate(() => document.documentElement.dataset.chain)).toBe('real');

    let asked = false;
    popup.on('dialog', (d) => {
      asked = true;
      d.accept();
    });
    await popup.locator('select.chip').selectOption('VRSCTEST');
    await expect.poll(() => popup.evaluate(() => document.documentElement.dataset.chain)).toBe('test');
    expect(asked, 'going back to testnet asked for confirmation').toBe(false);
  });
});

test('a session unlock holds derived bits, not the passphrase and not the key', async () => {
  // What is cached is the thing that decides how much a compromise of it is
  // worth. This asserts the shape directly, because it is the entire security
  // argument for the feature existing.
  await withExtension(async ({ context, extensionId }) => {
    const out = await inPage(context, extensionId, async () => {
      const { seal, unlockBits, openWith, bitsToText } = await import('../lib/vault.js');
      const { hold, held, release, minutesLeft } = await import('../lib/session.js');

      const PASS = 'correct horse battery';
      const WIF = 'UqYFzC8vJTAyMPYNQnRhqKZ2FiXMmyMYm2WMrWNRj6PmXbjuMYPq';
      const envelope = await seal('probe', 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', WIF, PASS);

      let wrong = null;
      try {
        await unlockBits(envelope, 'not it');
      } catch (error) {
        wrong = error.message;
      }
      // Nothing stored on a failure: the verification happens before the caller
      // ever gets bits to hold.
      const afterWrong = await held('probe');

      const bits = await unlockBits(envelope, PASS);
      await hold('probe', bitsToText(bits));
      const kept = await held('probe');

      const raw = await chrome.storage.session.get('verus-wallet.unlock');
      const stored = JSON.stringify(raw);

      // The cached bits still open the envelope, so this is a shortcut past the
      // typing rather than past the check.
      const opened = await openWith(envelope, bits);

      await release('probe');
      return {
        wrong,
        afterWrong,
        minutes: minutesLeft(kept.until),
        opened,
        holdsPassphrase: stored.includes(PASS),
        holdsWif: stored.includes(WIF),
        released: await held('probe'),
        onDisk: Object.keys(await chrome.storage.local.get(null)),
      };
    });

    expect(out.wrong).toMatch(/wrong passphrase/i);
    expect(out.afterWrong, 'a failed unlock was stored').toBeNull();
    expect(out.minutes).toBeGreaterThan(0);
    expect(out.minutes).toBeLessThanOrEqual(5);
    expect(out.opened, 'the cached bits do not open the envelope').toBe(
      'UqYFzC8vJTAyMPYNQnRhqKZ2FiXMmyMYm2WMrWNRj6PmXbjuMYPq',
    );
    expect(out.holdsPassphrase, 'the passphrase is in session storage').toBe(false);
    expect(out.holdsWif, 'the private key is in session storage').toBe(false);
    expect(out.released, 'Lock now left the unlock behind').toBeNull();
    // storage.session is memory; nothing about an unlock may reach the disk.
    expect(out.onDisk).not.toContain('verus-wallet.unlock');
  });
});
