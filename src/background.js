// The router. Holds no keys, loads no wasm, signs nothing.
//
// Its only job is to turn a page request into an approval window and carry the
// answer back. Signing happens in that window, where the passphrase was typed
// and where the decrypted key dies with the document.

import { sanitiseRequest, CODE, WalletError, PAGE_METHODS } from './lib/protocol.js';
import { currentNetwork } from './lib/rpc.js';
import { primary } from './lib/vault.js';
import { recall } from './lib/pending.js';

/**
 * Requests waiting on a human, by id.
 *
 * In memory, and that is a real limitation: MV3 stops an idle service worker
 * and this map goes with it, so an approval left open long enough will come
 * back to a worker that has forgotten it. The approval window detects that and
 * says so rather than appearing to succeed. Persisting it would mean writing
 * pending transaction details to disk, which is a worse trade.
 */
const waiting = new Map();
let counter = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'wallet:request') {
    handlePageRequest(message, sender)
      .then((result) => sendResponse({ result }))
      .catch((error) =>
        sendResponse({
          error: { code: error?.code ?? CODE.INTERNAL, message: error?.message ?? 'wallet error' },
        }),
      );
    return true; // async
  }

  if (message?.type === 'wallet:approval-ready') {
    const entry = waiting.get(message.id);
    sendResponse(entry ? { request: entry.request } : { expired: true });
    return false;
  }

  if (message?.type === 'wallet:approval-result') {
    const entry = waiting.get(message.id);
    if (entry) {
      waiting.delete(message.id);
      if (message.error) entry.reject(new WalletError(message.error.code, message.error.message));
      else entry.resolve(message.result);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handlePageRequest(message, sender) {
  const { method, params } = sanitiseRequest({ method: message.method, params: message.params });

  // Trust the sender's frame, never the message body.
  const origin = sender?.origin ?? sender?.url ?? message.origin ?? 'unknown origin';

  const key = await primary();
  if (!key) {
    throw new WalletError(CODE.UNAUTHORIZED, 'no key in the wallet — create or import one first');
  }

  const network = await currentNetwork();

  // Reading the address is not an action. Everything else needs a human.
  if (method === PAGE_METHODS.ADDRESS || method === PAGE_METHODS.CONNECT) {
    return { address: key.address, label: key.label, network: network.label };
  }

  // Also a read, and one the flow cannot work without: a commitment is
  // invisible on chain until the reveal, so a page re-reading chain state
  // after posting one correctly finds nothing and offers to start over.
  //
  // Only whether a name is mid-registration, and the commitment txid, which is
  // public the moment it is broadcast. Never the salt — that is the one value
  // that must not leave the wallet.
  if (method === PAGE_METHODS.REGISTRATION_STATE) {
    const [args = {}] = params;
    const name = String(args.name ?? '').trim().replace(/@$/, '');
    if (!name) return { state: 'none' };
    const held = await recall(network.label, name);
    return held
      ? { state: 'awaitingCommitment', name, commitmentTxid: held.commitmentTxid ?? null }
      : { state: 'none', name };
  }

  return openApproval({ method, params, origin, network: network.label, keyLabel: key.label });
}

/** Roughly MetaMask's notification window. Small enough to read as a dialog. */
const POPUP_WIDTH = 400;
const POPUP_HEIGHT = 620;
const POPUP_MARGIN = 20;

/**
 * Where to put the approval window.
 *
 * Without explicit coordinates, `chrome.windows.create` inherits the parent's
 * placement — and on macOS, when Chrome is in fullscreen, that means the popup
 * opens as a fullscreen space of its own. It looks like the wallet took over
 * the machine.
 *
 * So the window is pinned to the top-right of whatever window the user was
 * last looking at, clamped so a multi-monitor or half-width layout cannot push
 * it off-screen.
 */
async function popupBounds() {
  const fallback = { left: POPUP_MARGIN, top: POPUP_MARGIN };
  try {
    const parent = await chrome.windows.getLastFocused();
    if (!parent || !Number.isFinite(parent.width) || !Number.isFinite(parent.left)) return fallback;

    const right = parent.left + parent.width;
    return {
      left: Math.max(0, Math.round(right - POPUP_WIDTH - POPUP_MARGIN)),
      top: Math.max(0, Math.round(parent.top + POPUP_MARGIN)),
    };
  } catch {
    return fallback;
  }
}

function openApproval(request) {
  counter += 1;
  const id = `${Date.now()}-${counter}`;

  return new Promise((resolve, reject) => {
    waiting.set(id, { request, resolve, reject });

    createApprovalWindow(id)
      .then((created) => {
        // A window closed without answering is a rejection. Anything else
        // would leave the page hanging on a promise that can never settle.
        const onClosed = (closedId) => {
          if (closedId !== created.id) return;
          chrome.windows.onRemoved.removeListener(onClosed);
          const entry = waiting.get(id);
          if (entry) {
            waiting.delete(id);
            entry.reject(new WalletError(CODE.REJECTED, 'the request was dismissed'));
          }
        };
        chrome.windows.onRemoved.addListener(onClosed);
      })
      .catch((error) => {
        waiting.delete(id);
        reject(new WalletError(CODE.INTERNAL, error?.message ?? 'could not open the approval window'));
      });
  });
}

function createWindow(options) {
  return new Promise((resolve, reject) => {
    chrome.windows.create(options, (created) => {
      const failure = chrome.runtime.lastError;
      if (failure || !created) reject(new Error(failure?.message ?? 'no window was created'));
      else resolve(created);
    });
  });
}

/**
 * Open the approval window, positioned if possible and opened regardless.
 *
 * Positioning is attempted first and is **allowed to fail**. Chrome refuses a
 * `create` outright — no window at all — when the requested bounds are not at
 * least half on a visible screen:
 *
 *   Invalid value for bounds. Bounds must be at least 50% within visible screen space.
 *
 * A parent window near the right edge of a display, or on a secondary monitor
 * the extension cannot measure, is enough to trigger it. Treating that as fatal
 * would mean the wallet simply never appears for those users, which is far
 * worse than a popup in the wrong corner. So the second attempt drops the
 * coordinates and keeps `state: 'normal'` — which is the part that actually
 * stops macOS opening it as a fullscreen space.
 */
async function createApprovalWindow(id) {
  const base = {
    url: chrome.runtime.getURL(`src/ui/approve.html?id=${encodeURIComponent(id)}`),
    type: 'popup',
    focused: true,
    state: 'normal',
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
  };

  let created;
  try {
    created = await createWindow({ ...base, ...(await popupBounds()) });
  } catch {
    created = await createWindow(base);
  }

  // Chrome does not always honour `width`/`height` at creation — on the
  // fallback path it has been observed returning a window the size of the
  // parent, which is the very thing this is trying to avoid. Resizing after
  // the fact is cheap and makes the result deterministic.
  if (created.width !== POPUP_WIDTH || created.height !== POPUP_HEIGHT) {
    try {
      created = await chrome.windows.update(created.id, {
        state: 'normal',
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
      });
    } catch {
      // A window in the wrong shape still beats no window at all.
    }
  }
  return created;
}
