// Whether the chain is accepting conversions at all.
//
// # Why a wallet has to ask
//
// Verus can disable conversions chain-wide, and when it does **nothing else
// changes shape**. `getcurrency` still returns a live basket with reserves in
// it, `estimateconversion` still quotes a price, and this wallet will happily
// build and sign a conversion against all of it. The chain then refuses the
// transaction with `bad-txns-failed-precheck` — a message naming neither the
// switch nor the reason — at broadcast, after the passphrase.
//
// So health cannot be inferred from a working quote. It has to be read from the
// switch itself, which is what this does.
//
// # Where the switch lives
//
// Each chain designates a notification oracle identity; for these two it is the
// chain's own root ID. Its `contentmultimap` holds at most one upgrade
// descriptor under a VDXF key derived per chain from `vrsc::system.upgradedata`
// bound to that chain's id — so **the key differs by chain and must never be
// reused across them**: reading one chain's key against another finds nothing
// and reports a halted chain as clear.
//
// # The encoding
//
//     version              varint
//     minimumDaemonVersion varint
//     upgradeID            20 raw bytes, LITTLE-endian
//     activationHeight     varint
//     activationTime       varint
//
// Decoded here rather than trusted from anywhere else, and the varint is the
// part worth care: it is **Verus's, not Bitcoin's CompactSize**. Seven bits a
// byte, most significant first, and a set continuation bit also adds one — so
// `0x80 0x00` is 1, not 0. Read as CompactSize it yields plausible-looking
// numbers rather than an obvious failure, which is the whole trap.

import { rpc } from './rpc.js';

/** `disabledefi`, byte-reversed — the one switch that stops a conversion. */
export const DISABLE_DEFI = 'ba88b5b0691b237fbe909fba38053e9a17d49b5a';

/** Halts cross-chain movement but leaves conversions on this chain running. */
export const DISABLE_PBAAS_CROSSCHAIN = 'c8eb1ce97cc65b44b7c3b86315ef4419d5279ad9';
export const DISABLE_GATEWAY_CROSSCHAIN = 'cb287a8f91a05bf453d6052b22e7f1bdd9e84ff9';

function readVarInt(bytes, at) {
  let n = 0;
  let i = at;
  for (;;) {
    if (i >= bytes.length) throw new Error('varint runs past the end');
    const c = bytes[i++];
    // Multiplication, not `<< 7`: a shift in JS is a 32-bit operation and would
    // silently wrap a height above ~16M into a negative number.
    n = n * 128 + (c & 0x7f);
    if (!Number.isSafeInteger(n)) throw new Error('varint too large');
    if (c & 0x80) n += 1;
    else return [n, i];
  }
}

function fromHex(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('not hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * One descriptor, or null when this value is not one.
 *
 * Null rather than throwing: other record types can appear in a
 * `contentmultimap`, and one unreadable entry must not take the whole reading
 * with it.
 */
export function decodeUpgrade(hex) {
  if (typeof hex !== 'string') return null;
  try {
    const bytes = fromHex(hex);
    const [, afterVersion] = readVarInt(bytes, 0);
    const [, afterMinimum] = readVarInt(bytes, afterVersion);
    if (afterMinimum + 20 > bytes.length) return null;

    // Little-endian on the wire: reversed before it is compared to anything.
    const upgradeId = [...bytes.slice(afterMinimum, afterMinimum + 20)]
      .reverse()
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const [activationHeight] = readVarInt(bytes, afterMinimum + 20);
    return { upgradeId, activationHeight, raw: hex.toLowerCase() };
  } catch {
    return null;
  }
}

const cache = new Map();

/**
 * Whether conversions are halted on this network right now.
 *
 * Returns `null` when it could not be read — no oracle configured, an
 * unreachable node, an identity without the key. **Null is not "clear"**, and
 * the caller must not render it as such: a chain nobody could ask might be
 * halted, and the one thing this must never do is let missing data read as
 * working.
 *
 * A switch announced but not yet at its activation height is reported as
 * `halted: false` with the height, so a caller can say "from block N" rather
 * than stopping something that still works.
 */
export async function defiHalt(net) {
  const oracle = net?.oracle;
  if (!oracle?.identity || !oracle?.upgradeKey) return null;

  const held = cache.get(net.label);
  if (held) return held;

  let reading;
  try {
    const [tip, identity] = await Promise.all([
      rpc(net.node, 'getblockcount', []),
      rpc(net.node, 'getidentity', [oracle.identity]),
    ]);
    const values = identity?.identity?.contentmultimap?.[oracle.upgradeKey];
    if (!Array.isArray(values)) {
      // The key is absent, which is how a cleared switch looks. That IS a
      // reading, and it says conversions are running.
      reading = { halted: false, activationHeight: null, tip: Number(tip) || null };
    } else {
      const found = values
        .map(decodeUpgrade)
        .filter((entry) => entry && entry.upgradeId === DISABLE_DEFI)[0];
      const height = found ? found.activationHeight : null;
      reading = {
        halted: Boolean(found) && Number(tip) >= height,
        activationHeight: height,
        tip: Number(tip) || null,
      };
    }
  } catch {
    return null;
  }

  cache.set(net.label, reading);
  return reading;
}

/** What to tell somebody, or null when there is nothing to say. */
export function haltMessage(net, reading) {
  if (!reading) return null;
  if (reading.halted) {
    return (
      `conversions are halted on ${net.label} from block ${reading.activationHeight} — ` +
      'the chain refuses every one, so nothing can be converted until it is lifted'
    );
  }
  if (reading.activationHeight !== null) {
    return (
      `conversions stop on ${net.label} at block ${reading.activationHeight}` +
      (reading.tip ? ` — ${reading.activationHeight - reading.tip} block(s) away` : '')
    );
  }
  return null;
}
