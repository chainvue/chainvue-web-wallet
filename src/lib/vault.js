// Key storage.
//
// One encrypted blob per key in `chrome.storage.local`. The passphrase never
// leaves the window the user typed it into, the plaintext WIF exists only for
// the moment it takes to build a `Key`, and neither is ever sent to the service
// worker or the page.
//
// Crypto is WebCrypto only — PBKDF2-SHA256 to stretch the passphrase, AES-GCM
// to seal. No dependency, and nothing hand-rolled: the primitives are the
// browser's.

const STORE_KEY = 'verus-wallet.keys';

/**
 * OWASP's 2023 floor for PBKDF2-SHA256. It costs roughly a third of a second
 * on this hardware, which is the point — it is the only thing standing between
 * a stolen profile directory and the coins.
 */
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * Stretch a passphrase into the 256 bits that seal one envelope.
 *
 * Bits rather than a `CryptoKey`, because these are the thing a session unlock
 * has to be able to keep: an extension message channel is JSON, so a
 * non-extractable key object cannot cross one, while raw bits can be held in
 * `chrome.storage.session` and imported again on the other side. See
 * `lib/session.js` for why these and not the passphrase or the WIF.
 */
async function deriveBits(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/** Non-extractable on the way back in, so nothing can read the bits off it. */
function keyFromBits(bits, usages) {
  return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, usages);
}

async function deriveKey(passphrase, salt, usages) {
  return keyFromBits(await deriveBits(passphrase, salt), usages);
}

/**
 * Seal a WIF under a passphrase.
 *
 * The label and address are stored in clear on purpose: the popup has to list
 * keys and show balances without asking for a passphrase first, and an address
 * is public anyway.
 */
export async function seal(label, address, wif, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveKey(passphrase, salt, ['encrypt']);
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, encoder.encode(wif));

  return {
    version: 1,
    label,
    address,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', nonce: toBase64(nonce) },
    ciphertext: toBase64(new Uint8Array(sealed)),
  };
}

/**
 * Open a sealed envelope.
 *
 * A wrong passphrase surfaces as AES-GCM's authentication failure, which is
 * indistinguishable from a corrupted blob — deliberately. Telling the two apart
 * would tell an attacker which passphrases are close.
 */
export async function open(envelope, passphrase) {
  return openWith(envelope, await deriveBits(passphrase, fromBase64(envelope.kdf.salt)));
}

/**
 * The same decryption, from bits that have already been stretched.
 *
 * This is the whole of what a session unlock buys: PBKDF2 at 600,000 iterations
 * is the third of a second, and skipping it is skipping the typing rather than
 * skipping any check — a wrong unlock still fails AES-GCM's authentication here,
 * exactly as a wrong passphrase does.
 */
export async function openWith(envelope, bits) {
  const key = await keyFromBits(bits, ['decrypt']);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.cipher.nonce) },
      key,
      fromBase64(envelope.ciphertext),
    );
  } catch {
    throw new Error('wrong passphrase');
  }
  return decoder.decode(plain);
}

/**
 * Bits that open this envelope, proven against it before they are handed back.
 *
 * Verifying here rather than trusting the caller means a session unlock can
 * never be stored for a passphrase that was wrong — the failure arrives while
 * the field that produced it is still on screen.
 */
export async function unlockBits(envelope, passphrase) {
  const bits = await deriveBits(passphrase, fromBase64(envelope.kdf.salt));
  await openWith(envelope, bits); // throws 'wrong passphrase'
  return bits;
}

export { toBase64 as bitsToText, fromBase64 as bitsFromText };

// --- storage ---------------------------------------------------------------

export async function list() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  const keys = stored[STORE_KEY];
  return Array.isArray(keys) ? keys : [];
}

export async function add(envelope) {
  const keys = await list();
  if (keys.some((k) => k.label === envelope.label)) {
    throw new Error(`a key called "${envelope.label}" already exists`);
  }
  keys.push(envelope);
  await chrome.storage.local.set({ [STORE_KEY]: keys });
  return envelope;
}

export async function remove(label) {
  const keys = await list();
  await chrome.storage.local.set({ [STORE_KEY]: keys.filter((k) => k.label !== label) });
}

export async function find(label) {
  const keys = await list();
  return keys.find((k) => k.label === label) ?? null;
}

/** The key an approval defaults to. First registered wins; there is no ranking. */
export async function primary() {
  const keys = await list();
  return keys[0] ?? null;
}
