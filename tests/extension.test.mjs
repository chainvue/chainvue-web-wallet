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

test('the service worker starts and the wasm module loads in the popup', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    // "no keys yet" only renders after init() resolved, so seeing it proves
    // the 918 KB wasm module instantiated under the extension CSP.
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });
    expect(errors, errors.join(' | ')).toEqual([]);
  });
});

test('creating a key derives a real R-address and stores it encrypted', async () => {
  await withExtension(async ({ context, extensionId, worker }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

    await page.locator('input[placeholder="label"]').first().fill('test-key');
    await page.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await page.getByRole('button', { name: 'create key' }).click();

    await expect(page.getByText('test-key')).toBeVisible({ timeout: 15_000 });

    const address = await page.locator('.addr').first().textContent();
    expect(address).toMatch(/^R[1-9A-HJ-NP-Za-km-z]{25,40}$/);

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(setup.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });
    await setup.locator('input[placeholder="label"]').first().fill('reader');
    await setup.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await setup.getByRole('button', { name: 'create key' }).click();
    await expect(setup.getByText('reader')).toBeVisible({ timeout: 15_000 });

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
    await expect(setup.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });
    await setup.locator('input[placeholder="label"]').first().fill('reader');
    await setup.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await setup.getByRole('button', { name: 'create key' }).click();
    await expect(setup.getByText('reader')).toBeVisible({ timeout: 15_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(page.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

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
    await expect(setup.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });
    await setup.locator('input[placeholder="label"]').first().fill('wizard');
    await setup.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await setup.getByRole('button', { name: 'create key' }).click();
    await expect(setup.getByText('wizard')).toBeVisible({ timeout: 15_000 });

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
    await expect(setup.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });

    // A key must exist or the request is refused before any window opens.
    await setup.locator('input[placeholder="label"]').first().fill('approver');
    await setup.locator('input[placeholder="passphrase"]').first().fill('correct horse battery');
    await setup.getByRole('button', { name: 'create key' }).click();
    await expect(setup.getByText('approver')).toBeVisible({ timeout: 15_000 });

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
