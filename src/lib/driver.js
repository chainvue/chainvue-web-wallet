// Driving an SDK flow to completion.
//
// The SDK's flows do no I/O. Each round they return either `{kind: "ask", ask}`
// — complete JSON-RPC bodies to POST — or `{kind: "ready", value}`. This loop
// is the whole integration: fetch what was asked, record the replies verbatim,
// plan again.

import { postRaw } from './rpc.js';

/**
 * A flow that has not converged after this many rounds is looping, and looping
 * against a node means an unbounded stream of requests. The real flows settle
 * in a handful; this is a backstop, not a budget.
 */
const MAX_ROUNDS = 12;

/**
 * @param {(answers: object) => {kind: string, ask: string[], value?: unknown}} plan
 *   Called once per round. Must be a closure over the request — the driver
 *   never sees or reshapes it.
 * @param {object} answers A fresh `Answers`. See the note below on reuse.
 * @param {string} node
 * @param {(round: number, asked: number) => void} [onRound] progress, for the UI
 */
export async function drive(plan, answers, node, onRound) {
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const step = plan(answers);

    if (step.kind === 'ready') return step.value;
    if (step.kind !== 'ask') throw new Error(`unexpected plan step: ${step.kind}`);
    if (!step.ask.length) throw new Error('the flow asked for nothing but is not ready');

    onRound?.(round, step.ask.length);

    // The bodies within a round are independent — the SDK says so explicitly —
    // so fetching them concurrently is safe and is what makes this quick.
    const replies = await Promise.all(step.ask.map((body) => postRaw(node, body)));
    step.ask.forEach((body, i) => answers.record(body, replies[i]));
  }

  throw new Error(`the flow did not finish within ${MAX_ROUNDS} rounds`);
}

/**
 * Run one operation against a fresh view of the chain, then throw the view away.
 *
 * `Answers` is a frozen snapshot, not a connection: nothing in it expires, and
 * a second operation planned against a used one is planned against the first
 * one's tip and the first one's UTXO set — silently, because a stale answer is
 * indistinguishable from a fresh one. A wallet that kept one around would
 * eventually build a payment from coins it had already spent.
 *
 * So the lifetime is bound to the operation here, and callers cannot opt out.
 */
export async function runOnce(AnswersCtor, plan, node, onRound) {
  const answers = new AnswersCtor();
  try {
    return await drive(plan, answers, node, onRound);
  } finally {
    answers.free();
  }
}
