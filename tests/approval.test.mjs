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
    await expect(setup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(setup, 'probe', PASSPHRASE);

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
  //
  // Two outcomes count as passing, and both are evidence the request was sound.
  // On a running chain it reaches funding and fails there. On a chain with
  // `disabledefi` in force — VRSCTEST since block 1,187,000 — it is refused by
  // the halt check instead, which sits AFTER currency resolution and the `via`
  // rules, so getting that far still proves the shape. A malformed request
  // never reaches either.
  const HALTED = /conversions are halted/i;

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
    expect(
      REACHED_VALIDATION.test(out.status) || HALTED.test(out.status),
      `expected funding or a halt, got: ${out.status}`,
    ).toBe(true);
  });
});

test('a page names only the currency, and the wallet asks and checks the rest', async () => {
  // The interactive form. A site knows what somebody is looking at; it cannot
  // know what they hold, so it sends one field and the wallet asks.
  //
  // The key here is real and deliberately unfunded, which is exactly why the
  // picker lists routes rather than only holdings: an empty wallet must still
  // be able to reach the build, or this whole path would be untestable.
  await withWallet(async ({ context, page }) => {
    page
      .evaluate(() => {
        window.verus.request({ method: 'verus_convert', params: [{ into: 'dudecoin' }] }).catch(() => {});
      })
      .catch(() => {});

    const approval = await approvalWindow(context);

    // The form fills in from the chain before any passphrase is asked for.
    const direction = approval.locator('select[aria-label="direction"]');
    await expect(direction).toBeVisible({ timeout: 40_000 });
    await expect(direction).toContainText('dudecoin');

    // Receive the anchor, so the counter is what gets spent — the reserve-to-
    // reserve case, and the one that must carry `via`.
    await direction.selectOption('receive');
    await approval.locator('#convert-amount').fill('0.1');

    // An estimate has to land before the floor can be computed.
    await expect(approval.locator('.quote')).toContainText(/estimated|would not price|routes this pair/i, {
      timeout: 40_000,
    });

    // This key holds no VRSCTEST, and a conversion pays its fee in VRSCTEST. So
    // the form refuses rather than taking a passphrase for a transaction the
    // chain will answer with `bad-txns-failed-precheck` — a message naming
    // neither the fee nor the currency, arriving after the one moment somebody
    // was willing to sign.
    await expect(approval.getByText(/holds no VRSCTEST/)).toBeVisible({ timeout: 20_000 });
    await expect(approval.getByRole('button', { name: 'build transaction' })).toBeDisabled();
  });
});

test('a fully specified conversion still builds without asking anything', async () => {
  // The backwards-compatibility case. Everything the wallet did before the form
  // existed must still work, or every page already using it breaks.
  await withWallet(async ({ context, page }) => {
    page
      .evaluate(() => {
        window.verus
          .request({
            method: 'verus_convert',
            params: [{ from: 'VRSCTEST', into: 'dudecoin', via: 'dudebasket', kind: 'reserveToReserve', amount: '0.1' }],
          })
          .catch(() => {});
      })
      .catch(() => {});

    const approval = await approvalWindow(context);
    await expect(approval.getByText('what it will do')).toBeVisible({ timeout: 20_000 });
    expect(await approval.locator('select[aria-label="direction"]').count()).toBe(0);
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

// ---------------------------------------------------------------------------
// Sends, which start in the popup rather than on a page.

/**
 * A wallet with one real, unfunded key — and no launchpad site.
 *
 * `withWallet` needs the site because it drives `window.verus`. A send never
 * touches a page, so these tests run whether or not the site is served.
 */
async function withLocalWallet(run) {
  const profile = mkdtempSync(join(tmpdir(), 'verus-send-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).host;

    // Opened as a TAB, not as the toolbar popup. A real toolbar popup is
    // destroyed the moment the approval window takes focus; this one survives,
    // which is the only way to watch both. Nothing here should be read as
    // evidence that the popup lives in production — it does not.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/src/ui/popup.html`);
    await expect(popup.getByText('Make a wallet')).toBeVisible({ timeout: 30_000 });
    await createKey(popup, 'probe', PASSPHRASE);

    await run({ context, extensionId, worker, popup });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

test('a send gets past every shape check and fails on funds', async () => {
  // Driven straight from the popup DOCUMENT rather than through its form, and
  // that is not a shortcut around the UI: the test key is real but unfunded, so
  // it holds nothing and the form correctly offers nothing to send. The form's
  // own behaviour in that state is asserted separately below.
  //
  // What this covers is everything after the click — the sender check, the
  // worker's local branch, the approval window, and the DTO handed to
  // `planSend`. Landing on insufficient funds can only happen once all of that
  // has succeeded.
  await withLocalWallet(async ({ context, popup }) => {
    await popup.evaluate(async () => {
      const { PORT, SEND_PATH } = await import('../lib/protocol.js');
      await chrome.runtime.sendMessage({
        type: PORT.LOCAL_REQUEST,
        params: {
          path: SEND_PATH.NATIVE,
          to: 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU',
          amount: '0.1',
        },
      });
    });

    const approval = await approvalWindow(context);
    await approval.locator('#pass').fill(PASSPHRASE);
    await approval.getByRole('button', { name: 'build transaction' }).click();

    await expect
      .poll(async () => (await approval.locator('.status, .panel-title').allTextContents()).join(' | '), {
        timeout: 60_000,
      })
      .toMatch(/built|spendable|insufficient|error|cannot|refus|invalid|unexpected/i);

    const status = (await approval.locator('.status').textContent()) ?? '';
    expect(status, status).not.toMatch(MALFORMED);
    expect(status, `expected a funding rejection, got: ${status}`).toMatch(REACHED_VALIDATION);
  });
});

test('a send says it came from the wallet, not from a website', async () => {
  // The whole risk that sending introduces is a user reading a local send as a
  // site request or the reverse. The two headers must not be confusable.
  await withLocalWallet(async ({ context, popup }) => {
    await popup.evaluate(async () => {
      const { PORT, SEND_PATH } = await import('../lib/protocol.js');
      await chrome.runtime.sendMessage({
        type: PORT.LOCAL_REQUEST,
        params: { path: SEND_PATH.NATIVE, to: 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', amount: '0.1' },
      });
    });

    const approval = await approvalWindow(context);
    const text = await approval.locator('body').textContent();

    expect(text).toMatch(/no website asked for this/i);
    expect(text, 'a local send must not claim a site requested it').not.toMatch(/requested by/i);
    expect(text, 'no origin should appear').not.toMatch(/https?:\/\//);

    // And it still shows what is about to happen. The destination is asserted
    // through `data-address` because it is now rendered in groups — which is
    // the point, but it means the display string carries separators. Both are
    // checked: the real value, and that grouping did not alter it.
    const shown = approval.locator('[data-address]').first();
    expect(await shown.getAttribute('data-address')).toBe('RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU');
    expect((await shown.textContent()).replace(/\s+/g, '')).toBe('RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU');
    expect(text).toMatch(/0\.1/);
  });
});

test('rejecting a send closes the window and broadcasts nothing', async () => {
  await withLocalWallet(async ({ context, popup }) => {
    await popup.evaluate(async () => {
      const { PORT, SEND_PATH } = await import('../lib/protocol.js');
      await chrome.runtime.sendMessage({
        type: PORT.LOCAL_REQUEST,
        params: { path: SEND_PATH.NATIVE, to: 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', amount: '0.1' },
      });
    });

    const approval = await approvalWindow(context);
    await approval.getByRole('button', { name: 'reject' }).click();
    await expect
      .poll(() => context.pages().some((p) => p.url().includes('approve.html')), { timeout: 15_000 })
      .toBe(false);
  });
});

test('an unfunded wallet offers nothing to send rather than a broken form', async () => {
  await withLocalWallet(async ({ popup }) => {
    await popup.getByRole('button', { name: /Send/ }).click();

    // Asserted through the select's options rather than by visibility: an
    // <option> is never "visible" to a browser-driver, so waiting for it to
    // appear on screen waits forever on a panel that is working perfectly.
    //
    // The asset list is fetched when the panel opens, so this is waiting on a
    // real testnet read for an address that has never been used.
    await expect
      .poll(
        async () => (await popup.locator('select').last().locator('option').allTextContents()).join(),
        { timeout: 30_000 },
      )
      .toMatch(/nothing to send/);

    // A disabled control has to say what would enable it — the old form left
    // this grey beside an unrelated address error.
    const review = popup.getByRole('button', { name: 'Review payment' });
    await expect(review).toBeDisabled();
    expect(await review.getAttribute('title')).toMatch(/holds nothing/i);
  });
});

// --- staying unlocked -------------------------------------------------------

test('a session unlock survives into the next approval, and can be revoked', async () => {
  // The module's storage shape is asserted in extension.test.mjs. This is the
  // part that has to be true for the feature to mean anything: that the second
  // approval in a row does not ask again, and that it says so rather than
  // silently having become easier to spend from.
  await withLocalWallet(async ({ context, popup }) => {
    const send = () =>
      popup.evaluate(async () => {
        const { PORT, SEND_PATH } = await import('../lib/protocol.js');
        await chrome.runtime.sendMessage({
          type: PORT.LOCAL_REQUEST,
          params: { path: SEND_PATH.NATIVE, to: 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU', amount: '0.1' },
        });
      });

    await send();
    const first = await approvalWindow(context);
    await expect(first.locator('#pass')).toBeVisible();
    await first.locator('#pass').fill(PASSPHRASE);
    await first.locator('#keep').check();
    await first.getByRole('button', { name: 'build transaction' }).click();

    // The key was correct, so the unlock is kept — even though this build will
    // fail on funds, which is the whole point of storing it on a correct
    // passphrase rather than on a successful build.
    await expect
      .poll(async () => (await first.locator('.status').textContent()) ?? '', { timeout: 60_000 })
      .toMatch(REACHED_VALIDATION);
    await first.close();

    await send();
    const second = await approvalWindow(context);
    await expect(second.getByText(/Unlocked for \d+ min/)).toBeVisible({ timeout: 15_000 });
    expect(await second.locator('#pass').count(), 'it asked for the passphrase again').toBe(0);

    // And it can be given back on the spot.
    await second.getByRole('button', { name: 'Lock now' }).click();
    await expect(second.locator('#pass')).toBeVisible();
    await second.close();

    await send();
    const third = await approvalWindow(context);
    await expect(third.locator('#pass')).toBeVisible({ timeout: 15_000 });
    expect(await third.getByText(/Unlocked for/).count(), 'Lock now did not stick').toBe(0);
  });
});

test('the window that signs says which chain it is signing on', async () => {
  // The last screen where knowing costs anything. Nothing is built or broadcast
  // here — opening the window touches no node — so this is safe to run against
  // a mainnet request.
  await withLocalWallet(async ({ context, popup }) => {
    const request = () =>
      popup.evaluate(async () => {
        const { PORT, SEND_PATH } = await import('../lib/protocol.js');
        await chrome.runtime.sendMessage({
          type: PORT.LOCAL_REQUEST,
          params: { path: SEND_PATH.NATIVE, to: 'RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3', amount: '12.5' },
        });
      });

    await request();
    const onTest = await approvalWindow(context);
    expect(await onTest.locator('.chain-rail').count(), 'testnet carried a real-funds rail').toBe(0);
    const testAccent = await onTest.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    );
    await onTest.close();

    popup.once('dialog', (d) => d.accept());
    await popup.locator('select.chip').selectOption('VRSC');
    await expect.poll(() => popup.evaluate(() => document.documentElement.dataset.chain)).toBe('real');

    await request();
    const onMain = await approvalWindow(context);
    const rail = onMain.locator('.chain-rail');
    await expect(rail).toHaveText(/real funds/i);
    expect(await onMain.evaluate(() => document.documentElement.dataset.chain)).toBe('real');

    // Flush with the top of the window, above the heading — not tucked under it.
    const top = await rail.evaluate((n) => n.getBoundingClientRect().top);
    expect(top, `the rail sits ${top}px down the window`).toBeLessThanOrEqual(0);

    const mainAccent = await onMain.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    );
    expect(mainAccent, 'the approval window wears the same accent on both chains').not.toBe(testAccent);

    // And the two meanings that must not move with the chain did not: a send
    // the user started is still green, and the warning is still amber.
    const semantic = await onMain.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        local: root.getPropertyValue('--prov-local').trim(),
        warn: root.getPropertyValue('--warn').trim(),
      };
    });
    expect(semantic.local).toBe('#5fff87');
    expect(semantic.warn).toBe('#ffaf00');
    await expect(onMain.getByText(/no website asked for this/i)).toBeVisible();
  });
});
