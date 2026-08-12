// The switch that stops a conversion, decoded without a chain.
//
// # Why this is worth a test file of its own
//
// `disabledefi` was in force on VRSCTEST from block 1,187,000 and this wallet
// could not tell. Everything it looks at kept answering: `getcurrency` returned
// live baskets with reserves in them, `estimateconversion` quoted a price, the
// build funded and signed. The chain then refused the transaction with
// `bad-txns-failed-precheck` — a message naming neither the switch nor the
// reason — at broadcast, after the passphrase.
//
// So the reading has to come from the descriptor, and the descriptor is
// encoded in a way that fails quietly when read wrong: the varint is Verus's,
// not Bitcoin's CompactSize, and a CompactSize reader produces plausible
// numbers rather than an error. A wrong activation height reads as "not yet in
// force" — which is the halt going unannounced all over again.
//
// The fixtures are real payloads, taken from the two chains' own oracle
// identities.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISABLE_DEFI, decodeUpgrade, haltMessage } from '../src/lib/halt.js';

/** `VRSCTEST@` contentmultimap, key `iH51dFy7vF3LTRuVQvCTVu6QSbYfhTjek8`. */
const TESTNET = '018787a1035a9bd4179a3e0538ba9f90be7f231b69b0b588bac7b83800';

/** `VRSC@` contentmultimap, key `iSJ38vYX7qoCtotc9wBHb1vZdR3oTgoHCX`. */
const MAINNET = '018787a1025a9bd4179a3e0538ba9f90be7f231b69b0b588ba80fd8a5b00';

test('the testnet payload decodes to disabledefi at the block it really started', () => {
  const decoded = decodeUpgrade(TESTNET);
  assert.equal(decoded.upgradeId, DISABLE_DEFI);
  // The figure the chain published, and the one this wallet has to act on.
  assert.equal(decoded.activationHeight, 1_187_000);
});

test('the mainnet payload is the same switch at its own height', () => {
  // Same upgrade id, different chain, different height — which is why the
  // oracle key is per-chain and must never be shared between them.
  const decoded = decodeUpgrade(MAINNET);
  assert.equal(decoded.upgradeId, DISABLE_DEFI);
  assert.equal(decoded.activationHeight, 4_163_035);
});

test('the varint is Verus, not CompactSize', () => {
  // Read as CompactSize the testnet height comes out as something small and
  // plausible, and a plausible wrong height reads as "not in force yet". The
  // continuation bit adding one is the whole difference.
  assert.notEqual(decodeUpgrade(TESTNET).activationHeight, 0xc7);
  assert.ok(decodeUpgrade(TESTNET).activationHeight > 1_000_000);
});

test('a value that is not a descriptor is skipped, not thrown on', () => {
  // Other record types share a contentmultimap; one unreadable entry must not
  // take the whole reading with it.
  for (const value of [null, undefined, 42, '', 'zz', '0102', '01', {}]) {
    assert.equal(decodeUpgrade(value), null, `expected ${JSON.stringify(value)} to be skipped`);
  }
});

test('an unknown switch decodes without being mistaken for disabledefi', () => {
  // Only the id decides. Anything else in the map is somebody else's business.
  const other = TESTNET.replace('5a9bd4179a3e0538ba9f90be7f231b69b0b588ba', '11'.repeat(20));
  const decoded = decodeUpgrade(other);
  assert.ok(decoded);
  assert.notEqual(decoded.upgradeId, DISABLE_DEFI);
});

/* ---- what a person is told ------------------------------------------------ */

const net = { label: 'VRSCTEST' };

test('an active halt says which block it started at', () => {
  const message = haltMessage(net, { halted: true, activationHeight: 1_187_000, tip: 1_187_120 });
  assert.match(message, /halted on VRSCTEST/);
  assert.match(message, /1187000/);
});

test('a scheduled halt says how far off it is, and does not claim to be in force', () => {
  const message = haltMessage(net, { halted: false, activationHeight: 1_188_000, tip: 1_187_120 });
  assert.match(message, /stop on VRSCTEST at block 1188000/);
  assert.match(message, /880 block/);
  assert.doesNotMatch(message, /are halted/);
});

test('a clear chain says nothing at all', () => {
  assert.equal(haltMessage(net, { halted: false, activationHeight: null, tip: 1_187_120 }), null);
});

test('a reading that could not be taken says nothing rather than "clear"', () => {
  // Null is not clear. A chain nobody could ask might be halted, and the build
  // asks again and refuses there rather than this pretending to know.
  assert.equal(haltMessage(net, null), null);
});
