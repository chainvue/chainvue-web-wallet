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

/** Internal, between the bridge and the worker. */
export const PORT = Object.freeze({
  REQUEST: 'wallet:request',
  RESOLVE: 'wallet:resolve',
  APPROVAL_READY: 'wallet:approval-ready',
  APPROVAL_RESULT: 'wallet:approval-result',
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
