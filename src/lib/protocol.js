// The message vocabulary, shared by every context.
//
// Kept in one file so the page bridge, the service worker and the approval
// window cannot drift into disagreeing about a string.

/** Page → wallet. Anything not on this list is refused without being looked at. */
export const PAGE_METHODS = Object.freeze({
  CONNECT: 'verus_connect',
  ADDRESS: 'verus_address',
  REGISTER_IDENTITY: 'verus_registerIdentity',
  REGISTRATION_STATE: 'verus_registrationState',
  SEND_TOKEN_FROM_IDENTITY: 'verus_sendTokenFromIdentity',
  LAUNCH: 'verus_launchCurrency',
  CONVERT: 'verus_convert',
});

/**
 * Popup → worker. Deliberately NOT part of `PAGE_METHODS`.
 *
 * Sending is the one thing this wallet does that moves money to a destination
 * somebody else chose. Every page-facing method either pays a protocol fee or
 * pays the user's own address — `planConvert` is even handed
 * `recipient: key.address()` rather than anything the page asked for, because a
 * page that could name the recipient could route a swap into its own wallet.
 *
 * Putting a send on the page allowlist would hand back exactly that power, so
 * the two vocabularies are kept apart and `sanitiseRequest` never sees this one.
 */
export const LOCAL_METHODS = Object.freeze({ SEND: 'wallet_send' });

/** Which of the four shapes a send is. Decided by the popup, re-checked on build. */
export const SEND_PATH = Object.freeze({
  NATIVE: 'native', // the chain's own coin, from this key's address
  TOKEN: 'token', // a token at this key's address
  IDENTITY_TOKEN: 'identityToken', // a token held by an identity this key controls
  IDENTITY_NATIVE: 'identityNative', // native coin held by such an identity
});

/** Internal, between the bridge and the worker. */
export const PORT = Object.freeze({
  REQUEST: 'wallet:request',
  RESOLVE: 'wallet:resolve',
  APPROVAL_READY: 'wallet:approval-ready',
  APPROVAL_RESULT: 'wallet:approval-result',
  LOCAL_REQUEST: 'wallet:local-request',
  APPROVAL_OPEN: 'wallet:approval-open',
});

/** Marks messages on the page's `window` so the bridge can tell them apart. */
export const CHANNEL = Object.freeze({
  TO_WALLET: 'verus-wallet:to-wallet',
  TO_PAGE: 'verus-wallet:to-page',
});

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** Codes the page can branch on. Numbers follow the EIP-1193 convention. */
export const CODE = Object.freeze({
  REJECTED: 4001,
  UNAUTHORIZED: 4100,
  UNSUPPORTED: 4200,
  DISCONNECTED: 4900,
  INTERNAL: -32603,
  INVALID_PARAMS: -32602,
});

/**
 * Validate a page request before anything else touches it.
 *
 * The page is untrusted by definition. This is the only place its input is
 * shaped, and it returns a *new* object — never the caller's, which a hostile
 * page could keep mutating after the check passed.
 */
export function sanitiseRequest(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new WalletError(CODE.INVALID_PARAMS, 'request must be an object');
  }
  const method = String(raw.method ?? '');
  if (!Object.values(PAGE_METHODS).includes(method)) {
    throw new WalletError(CODE.UNSUPPORTED, `unsupported method: ${method}`);
  }
  const params = Array.isArray(raw.params) ? raw.params : [];
  if (params.length > 4) {
    throw new WalletError(CODE.INVALID_PARAMS, 'too many params');
  }

  // Round-trip through JSON: drops functions, getters, prototype tricks and
  // anything that would not survive being sent to another context anyway.
  let plain;
  try {
    plain = JSON.parse(JSON.stringify(params));
  } catch {
    throw new WalletError(CODE.INVALID_PARAMS, 'params must be JSON-serialisable');
  }
  return { method, params: plain };
}

/**
 * Refuse anything that is not this extension's own popup document.
 *
 * A web page cannot reach `chrome.runtime.sendMessage` at all — no
 * `externally_connectable` is declared — so the only forger within reach is the
 * content script this extension injects into every page. A content script's
 * sender carries the *page's* origin and the page's URL, never this
 * extension's, so the origin and URL checks are what exclude it. `popup.html`
 * is not in `web_accessible_resources` either, so no page can frame or navigate
 * to it and borrow the origin that way.
 *
 * It lives here rather than in `background.js` because a service worker cannot
 * be imported by a test page, and a rule this important should not be the one
 * thing that cannot be exercised.
 *
 * Note on what is deliberately NOT checked: an earlier version also refused any
 * sender carrying a `tab`, on the theory that the toolbar popup has none. That
 * is true, but it also refuses the popup opened as an ordinary tab — which a
 * user can legitimately do, and which is the only way this path can be tested
 * at all. It bought nothing: the origin and URL checks already exclude every
 * content script and every page, and no page can reach this document to begin
 * with. Security a test can never execute is a worse trade than the check was
 * worth.
 */
export function assertPopupSender(sender, runtimeId) {
  const own = `chrome-extension://${runtimeId}`;

  if (!runtimeId || sender?.id !== runtimeId) {
    throw new WalletError(CODE.UNAUTHORIZED, 'that request did not come from this extension');
  }
  if (sender?.origin !== own) {
    throw new WalletError(CODE.UNAUTHORIZED, 'a page cannot start a send');
  }
  if (!String(sender?.url ?? '').startsWith(`${own}/src/ui/popup.html`)) {
    throw new WalletError(CODE.UNAUTHORIZED, 'a send can only be started from the wallet popup');
  }
}

/**
 * Shape a send the popup asked for.
 *
 * The popup is our own code, so this is not a trust boundary in the way
 * `sanitiseRequest` is — but it is where a future bug would land, and the
 * values travel through the worker into the window that signs, so they are
 * shaped exactly as a page's would be.
 */
export function sanitiseLocalSend(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const path = String(source.path ?? '');
  if (!Object.values(SEND_PATH).includes(path)) {
    throw new WalletError(CODE.INVALID_PARAMS, `unknown send path: ${path || 'none'}`);
  }

  const to = String(source.to ?? '').trim();
  if (!to) throw new WalletError(CODE.INVALID_PARAMS, 'no destination');

  // Kept as a string all the way down. A float would silently lose the eighth
  // decimal place, which is a whole satoshi.
  const amount = String(source.amount ?? '').trim();
  if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) {
    throw new WalletError(CODE.INVALID_PARAMS, 'the amount must be a positive number with at most 8 decimal places');
  }

  const shaped = { path, to, amount };

  const needsCurrency = path === SEND_PATH.TOKEN || path === SEND_PATH.IDENTITY_TOKEN;
  if (needsCurrency) {
    // An `i…` id, never a name: the id is what the SDK takes, and a name is
    // chain data that anyone can choose.
    const currency = String(source.currency ?? '').trim();
    if (!/^i[1-9A-HJ-NP-Za-km-z]{25,}$/.test(currency)) {
      throw new WalletError(CODE.INVALID_PARAMS, 'a token send needs a currency id');
    }
    shaped.currency = currency;
    if (source.currencyName) shaped.currencyName = String(source.currencyName);
  }

  const needsIdentity = path === SEND_PATH.IDENTITY_TOKEN || path === SEND_PATH.IDENTITY_NATIVE;
  if (needsIdentity) {
    const identity = String(source.identity ?? '').trim();
    if (!identity) throw new WalletError(CODE.INVALID_PARAMS, 'no identity to send from');
    shaped.identity = identity;
  }

  if (source.keyLabel) shaped.keyLabel = String(source.keyLabel);
  return shaped;
}
