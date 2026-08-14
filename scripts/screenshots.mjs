// Captures the screenshots the README shows.
//
//   npm run screenshots
//
// The wallet is a browser extension, so there is no way to photograph it other
// than to run it: this loads the repo as an unpacked extension into a real
// Chrome — the same launch the tests use — drives the real UI, and writes PNGs
// to `docs/screenshots/`. Nothing is mocked and no image is retouched, so a
// screenshot that no longer matches the wallet is a screenshot that was not
// re-run rather than one that drifted.
//
// # The demo wallet
//
// Balances make the difference between a screenshot that shows a wallet and one
// that shows an empty state, and a fresh key has none. So the envelope written
// here carries a real, funded VRSCTEST address — the same public address the
// test suite already uses — while the key sealed inside it is a throwaway.
//
// That mismatch is deliberate and is the point: the demo wallet can display and
// cannot spend. Every number in the shots is read live from the testnet node,
// and the private key that would move those coins is not in this repo.
//
// # Why the shots are captured, not composed
//
// Each one is the popup at its own 360px, at 2× for a sharp result on a retina
// display, on the wallet's own background. Composing them onto a marketing
// canvas is what `store/screenshots/` is for; a README wants the thing itself.

import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');

/** Funded, public, testnet. Already in `tests/extension.test.mjs`. */
const DEMO_ADDRESS = 'RCvP2M7HjvGLHMf47qopqxsNGBmM97Q4n3';
/** Somewhere to send to in the Send shot — also public and already in the tests. */
const DEMO_RECIPIENT = 'RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU';
const PASSPHRASE = 'a screenshot passphrase';

/** How long the node gets before a shot is taken with holes in it. */
const SETTLE_MS = 45_000;

const shot = (name) => join(OUT, `${name}.png`);
const say = (message) => console.log(`  ${message}`);

/** Chrome with the extension loaded, at popup width. */
async function withWallet(run) {
  const profile = mkdtempSync(join(tmpdir(), 'verus-shots-'));
  const context = await chromium.launchPersistentContext(profile, {
    // See `tests/extension.test.mjs` — 'chrome' and the bundled Chromium both
    // fail to load an unpacked extension, silently.
    channel: 'chromium',
    headless: true,
    // The toolbar popup is 360 wide and Chrome caps it at 600 tall, so this is
    // the real frame rather than a chosen one. 2× because a README is read on
    // displays that would otherwise show blurred type.
    viewport: { width: 360, height: 600 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    await run({ context, extensionId: new URL(worker.url()).host });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Wait until nothing on screen is still a placeholder.
 *
 * The popup paints skeletons while it reads balances, and a shot taken during
 * that shows shimmer bars where the numbers belong. Waiting on the skeletons
 * themselves rather than on a fixed delay means a slow node makes this slower
 * instead of making the screenshot wrong.
 */
async function settled(page) {
  await page.waitForFunction(() => document.querySelectorAll('.skel').length === 0, null, {
    timeout: SETTLE_MS,
  });
  // The counterparty of each activity row is a second lookup that starts after
  // the row exists, and it has no skeleton of its own.
  await page.waitForTimeout(2_000);
}

/**
 * The whole view, not the 600px Chrome would cap it at.
 *
 * A capture at the popup's real height ends mid-row on anything with a list in
 * it, and a row sliced in half reads as a broken image rather than as a list
 * that scrolls. `fullPage` grows the frame to the content instead, which is the
 * same pixels a reader would reach by scrolling.
 */
async function capture(page, name) {
  // Trimmed to the content, in both directions. Chrome caps the popup at 600px
  // and scrolls the rest, so a capture at that height slices whatever row lands
  // on the boundary — and a row cut in half reads as a broken image rather than
  // as a list that scrolls. A short view has the opposite problem: `fullPage`
  // pads it out to the viewport and the shot ends in a field of black.
  const box = await page.evaluate(() => {
    const drawn = [...document.querySelectorAll('body *')].filter((node) => node.offsetParent !== null);
    const bottom = drawn.reduce((low, node) => Math.max(low, node.getBoundingClientRect().bottom), 0);
    return {
      width: document.documentElement.clientWidth,
      height: Math.min(Math.ceil(bottom + 16), document.documentElement.scrollHeight),
    };
  });
  await page.screenshot({ path: shot(name), fullPage: true, clip: { x: 0, y: 0, ...box } });
  say(`docs/screenshots/${name}.png  (${box.width} × ${box.height})`);
}

mkdirSync(OUT, { recursive: true });

await withWallet(async ({ context, extensionId }) => {
  const popup = `chrome-extension://${extensionId}/src/ui/popup.html`;
  const page = await context.newPage();
  await page.goto(popup);
  await page.getByText('Make a wallet').waitFor({ timeout: 30_000 });

  // The demo envelope. `seal` encrypts whatever WIF it is handed against
  // whatever address it is handed, and the two are only ever checked against
  // each other at signing time — which is what makes a display-only wallet
  // possible without a funded key in the repo.
  await page.evaluate(
    async ({ address, passphrase }) => {
      const wasm = await import('../vendor/verus-wasm/verus_wasm.js');
      await wasm.default();
      const throwaway = wasm.Key.fromEntropy(new Uint8Array(32).fill(9));
      const wif = throwaway.toWif();
      throwaway.free();

      const vault = await import('../lib/vault.js');
      await vault.add(await vault.seal('daily', address, wif, passphrase));
    },
    { address: DEMO_ADDRESS, passphrase: PASSPHRASE },
  );

  await page.goto(popup);
  await settled(page);
  await capture(page, 'wallet');

  await page.getByRole('button', { name: 'Receive' }).click();
  await page.locator('.qr canvas').waitFor({ timeout: 15_000 });
  await capture(page, 'receive');

  // Back to the top, then into Send. Receive has its own back button rather
  // than a route, so this reloads instead of guessing at its label.
  await page.goto(popup);
  await settled(page);
  await page.getByRole('button', { name: 'Send' }).click();

  // The asset list is disabled until the balances behind it have been read.
  await page.waitForFunction(
    () => !document.querySelector('select[aria-label="asset"]')?.disabled,
    null,
    { timeout: SETTLE_MS },
  );
  await page.getByPlaceholder('R… address').fill(DEMO_RECIPIENT);
  await page.getByPlaceholder('amount').fill('12.5');
  // The destination check is async — the shot is worth taking only once the
  // field has said what it thinks.
  await page.locator('#to-help.good').waitFor({ timeout: 15_000 });
  await capture(page, 'send');

  // Stage one of the approval, in its own window. Opening it from the popup
  // rather than from a website is what the local-send path does, and it needs
  // no launchpad site running.
  await page.getByRole('button', { name: 'Review payment' }).click();
  const approval = await waitForApproval(context);
  await approval.setViewportSize({ width: 400, height: 600 });
  await approval.waitForTimeout(1_000);
  await capture(approval, 'approve');
});

/** The approval window is an ordinary page — listed, never announced. */
async function waitForApproval(context) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = context.pages().find((p) => p.url().includes('approve.html'));
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      return found;
    }
    if (Date.now() > deadline) throw new Error('the approval window never opened');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
