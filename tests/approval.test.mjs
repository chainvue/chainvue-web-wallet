// Driving the approval window.
//
// # Why this file exists
//
// Every expensive bug in this extension lived in the approval window's build
// step, and none of them were reachable from the other tests:
//
//   * a freed wasm key           → "null pointer passed to rust"
//   * `{tokenFunding: undefined}` → "Reflect.get called on non-object"
//   * a bare name where the node wants `name@`
//   * the inner `pending` blob where the SDK wants its wrapper
//   * weights as fractions where the chain wants satoshis
//
// Each cost a round trip through a human, and one cost 200 VRSCTEST.
//
// The window turns out to be an ordinary page: `context.pages()` lists it, so
// the passphrase can be typed and "build transaction" clicked. An earlier
// attempt used `waitForEvent('page')`, which never fires for it, and concluded
// it was unreachable.
//
// # What these tests assert
//
// **That a build fails on FUNDS, not on SHAPE.** The key is real but unfunded,
// so every request ends in "insufficient funds" — and that outcome is the
// proof, because it can only be reached after argument parsing, identity
// resolution, DTO validation and every wasm call have succeeded. A shape bug
// produces a TypeError or a node `-8` long before funding is considered.
//
// Nothing is ever broadcast: the flow stops at stage one of the approval.

import { test, expect, chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8731';
const PASSPHRASE = 'correct horse battery';

/** An identity that exists but has not defined a currency. Verified per run. */
const NAME = process.env.FREE_IDENTITY ?? 'launchy-basket';

/**
 * Rejections that PROVE the request was structurally sound.
 *
 * Each can only be reached after argument parsing, identity resolution, DTO
 * validation and every wasm call have already succeeded — they are the chain
 * or the SDK objecting to circumstances, not to the shape of what was asked.
 *
 * The test key is real but unfunded and controls no identity, so a
 * well-formed request lands on one of these every time.
 */
const REACHED_VALIDATION =
  /insufficient|spendable|usable outputs|not enough|balance|need .* but only|primary addresses|already defines a currency/i;

/** Shapes that mean a malformed request reached wasm or the node. */
const MALFORMED = /Reflect\.get|null pointer|invalid type|expected struct|not a decimal|-8:|TypeError/i;

async function withWallet(run) {
  const profile = mkdtempSync(join(tmpdir(), 'verus-approval-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;

    // A real key, deliberately unfunded.
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(setup.getByText('no keys yet')).toBeVisible({ timeout: 30_000 });
    await setup.locator('input[placeholder="label"]').first().fill('probe');
    await setup.locator('input[placeholder="passphrase"]').first().fill(PASSPHRASE);
    await setup.getByRole('button', { name: 'create key' }).click();
    await expect(setup.getByText('probe')).toBeVisible({ timeout: 15_000 });

    const page = await context.newPage();
    const reached = await page.goto(SITE).catch(() => null);
    test.skip(!reached, `no launchpad site on ${SITE}`);
    await expect.poll(() => page.evaluate(() => Boolean(window.verus)), { timeout: 15_000 }).toBe(true);

    await run({ context, extensionId, worker, page });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The approval window, once it exists. Listed by `pages()`, never announced. */
async function approvalWindow(context) {
  let found = null;
  await expect
    .poll(
      () => {
        found = context.pages().find((p) => p.url().includes('approve.html')) ?? null;
        return Boolean(found);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await found.waitForLoadState('domcontentloaded');
  return found;
}

/**
 * Fire a page request, approve it as far as building, and report what happened.
 *
 * Returns the status text the window settled on — either the funding error the
 * request deserves, or the shape error that means something upstream is wrong.
 */
async function buildOnly(context, page, request) {
  page.evaluate((req) => {
    window.verus.request(req).catch(() => {});
  }, request).catch(() => {});

  const approval = await approvalWindow(context);
  await approval.locator('#pass').fill(PASSPHRASE);
  await approval.getByRole('button', { name: 'build transaction' }).click();

  // Either it built (stage two appears) or it failed with a reason.
  await expect
    .poll(async () => (await approval.locator('.status, .panel-title').allTextContents()).join(' | '), {
      timeout: 60_000,
    })
    .toMatch(/built|spendable|insufficient|error|cannot|refus|invalid|unexpected|primary|already/i);

  const status = (await approval.locator('.status').textContent()) ?? '';
  const titles = (await approval.locator('.panel-title').allTextContents()).join(' ');
  return { status, titles, built: /built/i.test(titles) };
}


/**
 * An identity that exists and has not defined a currency yet.
 *
 * Both launch tests need one, and the obvious candidates go stale the moment
 * they are used for real — `flop@` now answers "already defines a currency".
 * So the fixture is checked rather than assumed, and the test skips honestly
 * when the chain has moved on.
 */
async function freeIdentity(page, name) {
  const state = await page.evaluate(async (n) => {
    const r = await fetch('https://api.verustest.net', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'x', method: 'getidentity', params: [n + '@'] }),
    }).then((x) => x.json());
    if (r.error) return { exists: false };
    return { exists: true, flags: r.result.identity.flags };
  }, name);
  return state.exists && (state.flags & 1) === 0;
}

// ---------------------------------------------------------------------------

test('registering an identity gets past every shape check', async () => {
  await withWallet(async ({ context, page }) => {
    const out = await buildOnly(context, page, {
      method: 'verus_registerIdentity',
      params: [{ name: 'zzprobe-unclaimed' }],
    });
    expect(out.status, out.status).not.toMatch(MALFORMED);
    expect(out.status, `expected a semantic rejection, got: ${out.status}`).toMatch(REACHED_VALIDATION);
  });
});

test('launching a token gets past every shape check', async () => {
  // Covers the bare-name-vs-`name@` bug and the preallocation shape. A real
  // identity is needed so resolution actually runs.
  await withWallet(async ({ context, page }) => {
    test.skip(!(await freeIdentity(page, NAME)), `${NAME}@ is no longer free`);
    const out = await buildOnly(context, page, {
      method: 'verus_launchCurrency',
      params: [{ name: NAME, supply: '1000', startIn: 1 }],
    });
    expect(out.status, out.status).not.toMatch(MALFORMED);
    expect(out.status, `expected a semantic rejection, got: ${out.status}`).toMatch(REACHED_VALIDATION);
  });
});

test('launching a basket gets past every shape check', async () => {
  // Covers the weights-as-satoshis bug: fractions are refused by wasm with
  // "is not a decimal number of satoshis", long before funding matters.
  await withWallet(async ({ context, page }) => {
    test.skip(!(await freeIdentity(page, NAME)), `${NAME}@ is no longer free`);
    const out = await buildOnly(context, page, {
      method: 'verus_launchCurrency',
      params: [{
        name: NAME,
        reserves: ['VRSCTEST', 'dudecoin'],
        initialSupply: '1000',
        startIn: 40,
      }],
    });
    expect(out.status, out.status).not.toMatch(MALFORMED);
    expect(out.status, `expected a semantic rejection, got: ${out.status}`).toMatch(REACHED_VALIDATION);
  });
});

test('a native-funded swap gets past every shape check', async () => {
  // Covers `{tokenFunding: undefined}`: converting FROM the native coin leaves
  // the array empty, which is the case that threw "Reflect.get called on
  // non-object".
  await withWallet(async ({ context, page }) => {
    const out = await buildOnly(context, page, {
      method: 'verus_convert',
      params: [{
        from: 'VRSCTEST',
        into: 'dudecoin',
        via: 'dudebasket',
        kind: 'reserveToReserve',
        amount: '0.1',
      }],
    });
    expect(out.status, out.status).not.toMatch(MALFORMED);
    expect(out.status, `expected a semantic rejection, got: ${out.status}`).toMatch(REACHED_VALIDATION);
  });
});

test('a request the wallet cannot do is refused by name, not by crashing', async () => {
  await withWallet(async ({ context, page }) => {
    const refused = await page.evaluate(async () => {
      try {
        await window.verus.request({ method: 'verus_stealEverything', params: [] });
        return null;
      } catch (e) {
        return { code: e.code, message: e.message };
      }
    });
    expect(refused.code).toBe(4200);
    // Refused before any window opens.
    expect(context.pages().some((p) => p.url().includes('approve.html'))).toBe(false);
  });
});

test('rejecting closes the window and settles the page promise', async () => {
  await withWallet(async ({ context, page }) => {
    const outcome = page.evaluate(() =>
      window.verus
        .request({ method: 'verus_registerIdentity', params: [{ name: 'zzprobe-rejected' }] })
        .then(() => 'resolved')
        .catch((e) => `rejected:${e.code}`),
    );

    const approval = await approvalWindow(context);
    await approval.getByRole('button', { name: 'reject' }).click();

    // 4001 is "user rejected" — the page must be told, not left hanging.
    expect(await outcome).toBe('rejected:4001');
  });
});
