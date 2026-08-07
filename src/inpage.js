// `window.verus` — the entire surface a page gets.
//
// This runs in the page's own world, so the page can reach it and it can reach
// nothing. It holds no keys, talks to no node, and cannot read extension
// storage. All it does is post a message and wait.

(() => {
  const CHANNEL_TO_WALLET = 'verus-wallet:to-wallet';
  const CHANNEL_TO_PAGE = 'verus-wallet:to-page';

  if (window.verus) return; // another wallet got here first; do not fight over it

  const pending = new Map();
  let counter = 0;

  window.addEventListener('message', (event) => {
    // Only this window, only our channel. A message from an iframe or another
    // origin is not an answer to anything we asked.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL_TO_PAGE) return;

    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);

    if (data.error) {
      const error = new Error(data.error.message);
      error.code = data.error.code;
      entry.reject(error);
    } else {
      entry.resolve(data.result);
    }
  });

  const provider = {
    isVerusWallet: true,

    /**
     * Ask the wallet to do something.
     *
     * Resolves only after the user has approved and the transaction has been
     * broadcast. Rejects with code 4001 if they decline. There is no method
     * that returns a key, and no method that signs without showing the user
     * what is being signed.
     */
    request({ method, params = [] } = {}) {
      return new Promise((resolve, reject) => {
        counter += 1;
        const id = `${Date.now()}-${counter}`;
        pending.set(id, { resolve, reject });
        window.postMessage({ channel: CHANNEL_TO_WALLET, id, method, params }, window.location.origin);
      });
    },
  };

  Object.defineProperty(window, 'verus', {
    value: Object.freeze(provider),
    writable: false,
    configurable: false,
  });

  window.dispatchEvent(new Event('verus#initialized'));
})();
