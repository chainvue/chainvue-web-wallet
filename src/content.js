// The bridge between the page and the extension.
//
// Runs in the isolated world: it can see the page's `window.postMessage`
// traffic and it can talk to the service worker, but the page cannot reach
// into it. Everything crossing here is data — never a function, never a
// reference.

const CHANNEL_TO_WALLET = 'verus-wallet:to-wallet';
const CHANNEL_TO_PAGE = 'verus-wallet:to-page';

// Inject the provider into the page's own world. A file, not a string, so the
// page's CSP has something with an extension origin to allow and nothing is
// eval'd.
const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/inpage.js');
script.type = 'text/javascript';
(document.head ?? document.documentElement).prepend(script);
script.remove();

window.addEventListener('message', async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL_TO_WALLET) return;

  const reply = (payload) =>
    window.postMessage({ channel: CHANNEL_TO_PAGE, id: data.id, ...payload }, window.location.origin);

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'wallet:request',
      // The origin is stamped HERE, not taken from the message. A page can put
      // whatever it likes in a postMessage body; it cannot forge the frame it
      // is running in.
      origin: window.location.origin,
      method: data.method,
      params: data.params,
    });

    if (result?.error) reply({ error: result.error });
    else reply({ result: result?.result });
  } catch (error) {
    // The worker was asleep, restarting, or the extension was reloaded.
    reply({ error: { code: 4900, message: error?.message ?? 'the wallet is unreachable' } });
  }
});
