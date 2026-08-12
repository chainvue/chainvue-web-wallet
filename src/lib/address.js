// Deciding whether a typed destination is safe to pay.
//
// # Why this file exists
//
// Nothing else in this wallet validates an address. The SDK exports no
// validator — it parses addresses incidentally while building scripts, which is
// not a contract — and `asIdentityRef` in the approval window is a *normaliser*:
// it turns `not an address` into `not an address@` without complaint. That is
// right for a launch flow, where the caller already knows it named an identity,
// and wrong for a send box.
//
// # Why the checksum, and not a prefix-and-length regex
//
// A single mistyped character keeps the prefix and keeps the length. It yields
// a valid script paying a 20-byte hash nobody holds the key for; the chain
// accepts it and the coins are gone, with no bounce. Base58**check** exists for
// exactly that, and catches it with probability 1 − 2⁻³².
//
// "The SDK will reject it anyway" is not an answer even where it is true: that
// rejection arrives in the approval window, after the popup that held the form
// was destroyed, after a passphrase was typed and a key decrypted. This check
// runs on the keystroke, while there is still somewhere to fix it.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Version bytes, read off real addresses rather than taken from a spec.
 *
 * Decoded from the fixtures already in the test suite:
 *   RXdSvjZgRrNjtxVHEm13TH1pVTjt1obzKU → 60
 *   iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq → 102
 */
const VERSION_TRANSPARENT = 60; // R…
const VERSION_IDENTITY = 102; // i…
const VERSION_SCRIPT = 85; // b… — a script address; this wallet cannot pay one

/** version byte + 20-byte hash + 4-byte checksum. Nothing else is a Verus address. */
const DECODED_BYTES = 25;

export const KIND = Object.freeze({
  TRANSPARENT: 'transparent', // R… — pays a key
  IDENTITY: 'identity', // i… — pays a VerusID by its id
  NAME: 'name', // name@ — has to be resolved before it can be paid
});

/** Looks like it was meant to be an address, whatever the checksum says. */
const ADDRESS_SHAPED = /^[Ri][1-9A-HJ-NP-Za-km-z]{25,40}$/;

/**
 * Shielded prefixes.
 *
 * Sapling is `zs1…` on mainnet and `ztestsapling1…` on testnet; Sprout is `zc…`.
 * Tested for before base58 on purpose — see `parseDestination`.
 */
const SHIELDED = /^(zs1|ztestsapling1?|zc|z)/i;

function decodeBase58(text) {
  let n = 0n;
  for (const character of text) {
    const digit = ALPHABET.indexOf(character);
    // `0`, `O`, `I` and `l` are outside the alphabet precisely because they are
    // the characters people mistake for one another. Rejecting them here costs
    // nothing and catches a whole class of paste damage on its own.
    if (digit < 0) return null;
    n = n * 58n + BigInt(digit);
  }

  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  // No leading-zero handling. General base58 has to re-add a zero byte per
  // leading `1`, but neither version byte here is zero, so a valid address never
  // has one — and requiring exactly 25 bytes is both correct and shorter than
  // the general algorithm.
  return bytes;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Decode and verify a base58check string.
 *
 * @returns {Promise<{version: number, hash: Uint8Array} | null>} `null` when it
 *   is not base58check — bad alphabet, wrong length, or a checksum that does not
 *   match. The three are deliberately not distinguished: to a caller about to
 *   move money they all mean the same thing.
 */
export async function base58check(text) {
  const bytes = decodeBase58(String(text ?? ''));
  if (!bytes || bytes.length !== DECODED_BYTES) return null;

  const body = bytes.subarray(0, 21);
  const checksum = bytes.subarray(21);
  const expected = (await sha256(await sha256(body))).subarray(0, 4);

  for (let i = 0; i < 4; i += 1) if (expected[i] !== checksum[i]) return null;
  return { version: body[0], hash: body.subarray(1) };
}

/**
 * What a typed destination is, decided without asking the chain anything.
 *
 * @param {string} text
 * @returns {Promise<{kind: string, to: string}>} `to` is normalised — an address
 *   verbatim, a name as `name@`. A name still has to be resolved to its `i…`
 *   address before the SDK will accept it.
 * @throws {Error} with a message written for the person who typed it.
 */
export async function parseDestination(text) {
  const input = String(text ?? '').trim();
  if (!input) throw new Error('where is it going?');

  // Before base58, and that ordering is load-bearing: a Sprout `zc…` address is
  // itself valid base58check, so checked the other way round it would come out
  // as "unknown version byte" instead of the reason that is actually true.
  if (SHIELDED.test(input)) {
    throw new Error(
      'this wallet cannot send to a shielded (z) address — the signing library has no shielded support. Use an R… address, an i… address, or a name@.',
    );
  }

  if (input.includes('@')) {
    const name = input.replace(/@+$/, '');
    if (!name || name.includes('@') || /\s/.test(name) || name.length > 128) {
      throw new Error(`"${input}" is not a usable identity name`);
    }
    return { kind: KIND.NAME, to: `${name}@` };
  }

  const decoded = await base58check(input);
  if (decoded) {
    if (decoded.version === VERSION_TRANSPARENT) return { kind: KIND.TRANSPARENT, to: input };
    if (decoded.version === VERSION_IDENTITY) return { kind: KIND.IDENTITY, to: input };
    if (decoded.version === VERSION_SCRIPT) {
      throw new Error('a b… script address is not something this wallet can pay');
    }
    throw new Error(`that is not a Verus address (version byte ${decoded.version})`);
  }

  // Right shape, wrong checksum. This is the message the whole module is for:
  // it is the difference between "you made a typo" and the coins being gone.
  if (ADDRESS_SHAPED.test(input)) {
    throw new Error('that address has a typo — its checksum does not match. Check every character.');
  }

  // A bare name is refused rather than guessed. `asIdentityRef` would happily
  // make this `alice@`, which is the right call where the caller already knows
  // it is naming an identity — and the wrong one here, where a mistyped address
  // must never quietly become an identity name.
  if (/^[a-z0-9._-]{1,64}$/i.test(input)) {
    throw new Error(`an identity has to be written with its @ — did you mean "${input}@"?`);
  }

  throw new Error(
    'that is not an address or an identity name. Use an R… address, an i… address, or a name ending in @.',
  );
}
