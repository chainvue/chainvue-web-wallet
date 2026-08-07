// The approval window.
//
// The only place in this extension where a key is decrypted, and the only place
// wasm is loaded. Both die when this document closes.
//
// The flow is deliberately two-stage:
//
//   1. show what the page asked for, take the passphrase, BUILD
//   2. show what was actually built — txid, fee, what it costs — then BROADCAST
//
// Stage 2 exists because a request is a claim and a built transaction is a
// fact. Signing straight from the page's description would mean approving what
// the page said, not what the wallet made.

import init, {
  Key,
  Answers,
  parseCoins,
  formatCoins,
  planCommitmentStatus,
} from '../vendor/verus-wasm/verus_wasm.js';
import { el, mount, row, panel } from '../lib/dom.js';
import { NETWORKS, rpc, broadcast, tokenUtxos } from '../lib/rpc.js';
import { runOnce } from '../lib/driver.js';
import { find, primary, open as openVault } from '../lib/vault.js';
import { remember, recall, forget } from '../lib/pending.js';

const root = document.getElementById('root');
const id = new URLSearchParams(location.search).get('id');

const CONFIRMATIONS_AHEAD = 20; // blocks between now and a launch's start

/** The reserve transfer fee, in native coins. Matches pecu's default. */
const RESERVE_TRANSFER_FEE = '0.0002';

async function boot() {
  await init();

  const answer = await chrome.runtime.sendMessage({ type: 'wallet:approval-ready', id });
  if (!answer || answer.expired) {
    mount(
      root,
      panel('expired', [
        el('p', { class: 'warn' }, 'this request is no longer held by the wallet'),
        el('p', { class: 'muted small' }, 'The background worker was stopped while the window was open. Nothing was signed. Try again from the page.'),
      ]),
    );
    return;
  }
  renderRequest(answer.request);
}

function renderRequest(request) {
  const net = NETWORKS[request.network] ?? NETWORKS.VRSCTEST;
  const pass = el('input', { type: 'password', id: 'pass', autocomplete: 'current-password' });
  const status = el('div', { class: 'status' });

  const build = el('button', { type: 'button' }, 'build transaction');
  const cancel = el('button', { type: 'button', class: 'secondary' }, 'reject');

  cancel.addEventListener('click', () => reject('the request was rejected'));
  build.addEventListener('click', async () => {
    build.disabled = true;
    cancel.disabled = true;
    mount(status, el('span', { class: 'muted' }, 'unlocking…'));
    try {
      const built = await buildTransaction(request, net, pass.value, (text) =>
        mount(status, el('span', { class: 'muted' }, text)),
      );
      renderBuilt(request, net, built);
    } catch (error) {
      mount(status, el('span', { class: 'danger' }, error?.message ?? 'could not build the transaction'));
      build.disabled = false;
      cancel.disabled = false;
    }
  });

  mount(
    root,
    el('div', { class: 'origin' }, [el('div', { class: 'small' }, 'requested by'), el('div', {}, request.origin)]),
    panel('what it will do', describe(request)),
    panel('signing with', [row('key', request.keyLabel), row('chain', net.label)]),
    el('div', {}, [el('label', { for: 'pass' }, 'passphrase'), pass]),
    el('div', { class: 'buttons' }, [cancel, build]),
    status,
  );
  pass.focus();
}

/** What the page claims it wants. Rendered as text, never trusted as truth. */
function describe(request) {
  const [params = {}] = request.params;

  if (request.method === 'verus_registerIdentity') {
    return [
      row('action', 'claim a name'),
      row('name', `${String(params.name ?? '—').replace(/@$/, '')}@`),
      params.referral
        ? row('referred by', String(params.referral))
        : null,
      params.referral
        ? el(
            'p',
            { class: 'muted small' },
            'A referral lowers what you pay and credits the referrer out of the fee. It does not give them any control over the name.',
          )
        : null,
      el(
        'p',
        { class: 'warn small' },
        'Claiming a name takes two transactions a block apart. The first spends the registration fee; only the second creates the identity. Do not clear this extension between them.',
      ),
    ].filter(Boolean);
  }

  if (request.method === 'verus_sendTokenFromIdentity') {
    return [
      row('action', 'move a token out of an identity'),
      row('from', String(params.identity ?? '—')),
      row('token', String(params.currency ?? '—')),
      row('amount', String(params.amount ?? '—')),
      el(
        'p',
        { class: 'muted small' },
        'A token preallocated at launch belongs to its identity. Moving it to this wallet\'s address is what makes it spendable — the identity keeps everything else.',
      ),
    ];
  }

  if (request.method === 'verus_launchCurrency') {
    const basket = (params.reserves ?? []).length > 0;
    return [
      row('action', basket ? 'launch a basket' : 'launch a token'),
      row('name', String(params.name ?? '—')),
      basket ? row('reserves', params.reserves.join(' + ')) : null,
      basket && params.weights ? row('weights', params.weights.join(' / ')) : null,
      row('supply', String(params.supply ?? params.initialSupply ?? '—')),
      params.startIn ? row('starts in', `${params.startIn} block(s)`) : null,
      !basket
        ? el(
            'p',
            { class: 'muted small' },
            'A token\'s supply is preallocated to the defining identity, not to this wallet\'s address. Spending it later means spending as the identity.',
          )
        : null,
      el('p', { class: 'warn small' }, 'A launch burns a registration fee and cannot be undone.'),
    ].filter(Boolean);
  }

  if (request.method === 'verus_convert') {
    const preconvert = params.kind === 'preconvert';
    return [
      row('action', preconvert ? 'join a launch' : 'swap'),
      row('spend', `${params.amount ?? '—'} ${params.from ?? ''}`),
      row(preconvert ? 'into' : 'receive', String(params.into ?? '—')),
      params.via ? row('routed through', String(params.via)) : null,
      row('kind', String(params.kind ?? 'intoFractional')),
      !preconvert && params.minExpected
        ? row('at least', `${params.minExpected} ${params.into ?? ''}`)
        : null,
      preconvert
        ? el(
            'p',
            { class: 'warn small' },
            'A launch contribution is not a trade. It pays out at the start block at a price the chain decides then — and if the launch fails, it is refunded.',
          )
        : null,
      el('p', { class: 'muted small' }, 'The payout goes to this wallet\'s own address. The page cannot choose where it lands.'),
    ].filter(Boolean);
  }

  return [row('action', request.method)];
}

async function buildTransaction(request, net, passphrase, progress) {
  const envelope = (await find(request.keyLabel)) ?? (await primary());
  if (!envelope) throw new Error('the key is gone from the wallet');

  progress('decrypting the key…');
  const wif = await openVault(envelope, passphrase);

  const key = Key.fromWif(wif);
  try {
    // ONE awaited call, on purpose.
    //
    // The branches used to live inline here, and one of them did `return
    // someAsyncFn(key, …)` without awaiting. That hands back a pending promise,
    // so this `finally` ran immediately and freed the wasm object while the
    // operation was still using it — surfacing as the useless "null pointer
    // passed to rust". Every path now goes through a single `await`, so there
    // is no longer a place to make that mistake.
    return await dispatch(key, request, net, progress);
  } finally {
    // The decrypted key lives exactly as long as the operation.
    key.free();
  }
}

async function dispatch(key, request, net, progress) {
  {
    const [params = {}] = request.params;

    if (request.method === 'verus_registerIdentity') {
      return registerIdentity(key, params, net, progress);
    }

    // Move a token out of the identity that holds it.
    //
    // A non-mintable token's supply is preallocated to its defining identity
    // and never touches a key-held address, so this is the only way to reach
    // it — `planConvert`'s `tokenFunding` is key-signed and refuses an
    // identity output outright.
    //
    // Two steps rather than one: move it here, then preconvert from the
    // address with the ordinary path. A conversion funded straight from an
    // identity would save the hop but does not exist yet.
    if (request.method === 'verus_sendTokenFromIdentity') {
      progress('resolving the token…');
      const currency = await currencyId(net, params.currency);
      return {
        kind: 'convert',
        value: await runOnce(
          Answers,
          (answers) =>
            key.planSendTokenFromIdentity(
              {
                identity: asIdentityRef(params.identity),
                currency,
                // Its own address by default: the point is to get the token
                // somewhere this key can spend it.
                to: params.to || key.address(),
                amount: parseCoins(String(params.amount)),
              },
              answers,
            ),
          net.node,
          (round, asked) => progress(`round ${round} — asking the node ${asked} thing(s)…`),
        ),
      };
    }

    if (request.method === 'verus_launchCurrency') {
      const definition = await launchDefinition(params, net, progress);
      progress('planning the launch…');
      return {
        kind: 'launch',
        value: await runOnce(
          Answers,
          // `identity` needs the friendly form with its `@`; `definition.name`
          // needs the bare one. Passing the bare name here is refused by the
          // node with `-8: Identity parameter must be valid friendly name or
          // identity address`.
          (answers) => key.planLaunch({ identity: asIdentityRef(params.name), definition }, answers),
          net.node,
          (round, asked) => progress(`round ${round} — asking the node ${asked} thing(s)…`),
        ),
      };
    }

    if (request.method === 'verus_convert') {
      progress('planning the conversion…');
      const kind = params.kind ?? 'intoFractional';
      const from = await currencyId(net, params.from);
      const into = await currencyId(net, params.into);
      // `via` names the basket a reserve-to-reserve trade routes through, and
      // is required for that kind: without it there is no pool to price
      // against and the SDK has nothing to route.
      const via = params.via ? await currencyId(net, params.via) : undefined;
      if (kind === 'reserveToReserve' && !via) {
        throw new Error('a reserve-to-reserve swap needs a basket to route through');
      }
      // A preconvert has no market to route through or price against: the
      // basket does not exist yet. `minExpected` is deliberately never set for
      // this kind — there is no rate to compare a floor to, and consensus
      // settles every contribution together at the start block.
      if (kind === 'preconvert' && via) {
        throw new Error('a preconvert goes straight into the launching currency; it cannot be routed');
      }

      // `tokenFunding` is needed whenever the source is a TOKEN — not only
      // when it is held by an identity. Native coins are funded by the flow
      // itself; anything else has to be handed in as outputs.
      //
      // Two holders are possible and the difference matters: a supply
      // preallocated at launch belongs to the defining IDENTITY, while
      // anything bought since sits at this key's own address. Getting it wrong
      // fails as "insufficient funds" while the explorer plainly shows the
      // balance.
      let tokenFunding;
      const nativeId = await currencyId(net, net.native);
      if (from !== nativeId) {
        let holderAddress = key.address();
        let label = 'this wallet';

        if (params.fromIdentity) {
          progress("resolving the identity's outputs…");
          const holder = await rpc(net.node, 'getidentity', [asIdentityRef(params.fromIdentity)]);
          holderAddress = holder?.identity?.identityaddress;
          label = String(params.fromIdentity);
          if (!holderAddress) throw new Error(`no identity called "${params.fromIdentity}"`);
        } else {
          progress('gathering outputs…');
        }

        tokenFunding = await tokenUtxos(net.node, holderAddress, from);
        if (tokenFunding.length === 0) {
          throw new Error(`${label} holds none of ${params.from}`);
        }
      }

      // OMIT optional keys, never set them to `undefined`.
      //
      // `tokenFunding` is an array field, and the DTO reader iterates it
      // whenever the key is *present* — so `{tokenFunding: undefined}` throws
      // `TypeError: Reflect.get called on non-object`, while leaving the key
      // out entirely is fine. Scalar options like `via` and `minExpected`
      // tolerate `undefined`, which is why only this one failed.
      const convertRequest = {
        from,
        into,
        kind,
        amount: parseCoins(String(params.amount)),
        // Payout goes to the signing key, never to an address the page chose.
        // A page that could name the recipient could route a user's swap into
        // its own wallet.
        recipient: key.address(),
        fee: parseCoins(RESERVE_TRANSFER_FEE),
      };
      if (via) convertRequest.via = via;
      if (tokenFunding?.length) convertRequest.tokenFunding = tokenFunding;

      // A floor on what the trade may return.
      //
      // Nothing enforces this on chain — the SDK refuses to sign if the node's
      // own estimate has already fallen below it, which is the only price
      // check that exists. Worth having anyway: a conversion settles at the
      // block boundary, so the rate can move between quoting and signing.
      //
      // Never for a preconvert. There is no market yet, so there is no rate to
      // compare a floor against, and the SDK rejects one outright.
      if (kind !== 'preconvert' && params.minExpected) {
        convertRequest.minExpected = parseCoins(String(params.minExpected));
      }

      return {
        kind: 'convert',
        value: await runOnce(
          Answers,
          (answers) =>
            key.planConvert(convertRequest, answers),
          net.node,
          (round, asked) => progress(`round ${round} — asking the node ${asked} thing(s)…`),
        ),
      };
    }

    throw new Error(`this wallet cannot do ${request.method}`);
  }
}

/**
 * Claim a name. Two transactions, a block apart, resumable.
 *
 * Which phase runs is decided by what is in storage, not by what the page
 * asked for — so a page can call this repeatedly and it advances. That is what
 * lets the whole flow be driven from chain state with one button.
 *
 * The salt lives in the opaque `pending` blob and exists nowhere else, on
 * chain or off. It is written to storage **before this returns**, so the
 * broadcast in stage two of the UI can never happen against an unsaved
 * commitment.
 */
async function registerIdentity(key, params, net, progress) {
  const name = String(params.name ?? '').trim().replace(/@$/, '');
  if (!name) throw new Error('no name to register');

  const rounds = (round, asked) => progress(`round ${round} — asking the node ${asked} thing(s)…`);
  const held = await recall(net.label, name);

  if (!held) {
    progress('planning the commitment…');

    // A referral makes the registration CHEAPER, not dearer: the registrant
    // pays `fee * (levels+1)/(levels+2)` and each referrer takes
    // `fee/(levels+2)`. On VRSCTEST's 100 over 3 levels that is 80 paid and 20
    // to the referrer, with the rest burned.
    //
    // Only for a top-level name. A sub-identity records its referral and pays
    // it nothing — the whole fee goes to the parent instead — so passing one
    // there would promise the referrer money that never arrives.
    const registration = { name };
    if (params.referral) registration.referral = asIdentityRef(params.referral);

    const pending = await runOnce(
      Answers,
      (answers) => key.planRegistration(registration, answers),
      net.node,
      rounds,
    );

    // The WHOLE `Pending` object, not its inner `.pending` string.
    //
    // `PendingRequest` takes the wrapper — `{ state, name, registrationFee,
    // commitmentHex, commitmentTxid, pending }` — and handing it the inner
    // opaque blob instead fails deserialization with
    // `invalid type: string …, expected struct JsPending`. The inner string is
    // one field of the thing to store, not the thing itself.
    await remember(net.label, name, {
      pending,
      commitmentTxid: pending.commitmentTxid,
      registrationFee: pending.registrationFee,
    });

    return { kind: 'commit', name, value: { ...pending, hex: pending.commitmentHex, txid: pending.commitmentTxid } };
  }

  // Three steps, not two, and the middle one is easy to miss.
  //
  //   anchor  — records WHERE the commitment landed. Returns the value still
  //             at "awaitingCommitment", so its state says nothing about
  //             whether it confirmed.
  //   status  — checks confirmations against that anchor and is the only thing
  //             that hands back "readyToRegister".
  //   complete — refuses anything that is not already at "readyToRegister".
  //
  // Reading the anchor's state as the verdict makes a confirmed commitment
  // look permanently unconfirmed, which is exactly what it did.
  progress('locating the commitment…');
  const wrapper = asPending(held, name);

  const anchored = await runOnce(
    Answers,
    (answers) => key.planCommitmentAnchor({ pending: wrapper }, answers),
    net.node,
    rounds,
  );
  await remember(net.label, name, { ...held, pending: anchored });

  progress('checking confirmations…');

  // `planCommitmentStatus` does NOT return a `Pending`. It returns a union
  // discriminated by `kind`, and the wrapper only exists inside the `ready`
  // variant:
  //
  //   { kind: "waiting", confirmations }   { kind: "ready", pending }
  //   { kind: "reorged", detail }          { kind: "gone" }
  //
  // Reading `.state` off it finds `undefined` on every variant, so the check
  // failed identically whether the commitment had one confirmation or twenty.
  const status = await runOnce(
    Answers,
    (answers) => planCommitmentStatus({ pending: anchored }, answers),
    net.node,
    rounds,
  );

  if (status.kind === 'waiting') {
    const n = status.confirmations ?? 0;
    throw new Error(
      `the commitment has ${n} confirmation${n === 1 ? '' : 's'} and is not spendable yet — wait a block and try again`,
    );
  }
  if (status.kind === 'reorged') {
    throw new Error(
      `the chain reorganised under this commitment (${status.detail}). Re-check in a few blocks; if it does not settle, the name has to be claimed again.`,
    );
  }
  if (status.kind === 'gone') {
    throw new Error(
      'the commitment is no longer on chain. Its fee is spent and cannot be recovered — claim the name again to start over.',
    );
  }
  if (status.kind === 'expired') {
    throw new Error(
      `the commitment expired (height ${status.expiryHeight ?? '?'}, tip ${status.tip ?? '?'}). Its fee is spent — claim the name again.`,
    );
  }
  if (status.kind !== 'ready' || !status.pending) {
    throw new Error(`unexpected commitment status: ${status.kind ?? 'none'}`);
  }

  const confirmed = status.pending;

  // Store the confirmed wrapper before going on: losing it here would strand
  // the commitment just as surely as losing the first one.
  await remember(net.label, name, { ...held, pending: confirmed });

  progress('planning the registration…');
  const done = await runOnce(
    Answers,
    // `confirmed`, not `anchored`: completion refuses anything that is not
    // already at "readyToRegister", and only status produces that.
    (answers) => key.planRegistrationComplete({ pending: confirmed }, answers),
    net.node,
    rounds,
  );

  return { kind: 'register', name, value: done };
}

/**
 * Read a stored record as the `Pending` wrapper the SDK wants.
 *
 * An earlier build saved only the inner opaque string, so commitments made
 * with it cannot be resumed as-is — and each one has a registration fee
 * already spent behind it. Rather than strand them, the wrapper is rebuilt:
 * every field except `commitmentHex` was stored alongside, and that one is
 * recoverable from the blob.
 *
 * Reaching into the blob is exactly what its documentation says not to do, and
 * it is done here only to repair records that predate the fix. Anything saved
 * from now on is already an object and takes the first branch.
 */
export function asPending(held, name) {
  if (held.pending && typeof held.pending === 'object') return held.pending;

  let commitmentHex = held.commitmentHex ?? '';
  if (!commitmentHex) {
    try {
      commitmentHex = JSON.parse(held.pending)?.commitment_hex ?? '';
    } catch {
      throw new Error(
        'this commitment was saved by an older build and cannot be read. The fee is spent; register the name again, or finish it with the pecu CLI.',
      );
    }
  }

  return {
    state: 'awaitingCommitment',
    name,
    registrationFee: String(held.registrationFee ?? '0'),
    commitmentHex,
    commitmentTxid: held.commitmentTxid ?? '',
    pending: held.pending,
  };
}

/**
 * Turn the page's request into a definition the SDK will accept.
 *
 * Two shapes, decided by whether reserves were named:
 *
 * * **token** — fixed supply, preallocated to the defining identity. This is
 *   the coin people end up holding.
 * * **fractional** — the pool the token trades against. Needs two or more
 *   reserves: with one, weights must sum to 1 so the single weight is 100%,
 *   and reserve and supply then move together — a fixed price by construction,
 *   which is not a market.
 *
 * `initialContributions` is deliberately absent. The SDK's launch builder makes
 * no output to fund it, so declaring it would claim backing the transaction
 * does not pay (chainvue/verus-rust-sdk#121). Reserves are seeded by
 * preconverting after the definition lands.
 */
/**
 * How the node wants an identity named.
 *
 * A friendly name carries its `@`; an `i…` address must not have one bolted
 * on. The two forms are not interchangeable and the daemon rejects the wrong
 * one outright, so the distinction is made once, here, rather than at each
 * call site.
 */
export function asIdentityRef(nameOrId) {
  const s = String(nameOrId ?? '').trim();
  if (!s) throw new Error('no identity was named');
  if (s.endsWith('@')) return s;
  if (/^i[1-9A-HJ-NP-Za-km-z]{25,}$/.test(s)) return s; // already an i-address
  return `${s}@`;
}

export async function launchDefinition(params, net, progress = () => {}) {
  progress('reading chain policy…');
  const parent = await currencyId(net, net.native);
  const tip = await rpc(net.node, 'getblockcount', []);

  const reserves = Array.isArray(params.reserves) ? params.reserves.filter(Boolean) : [];

  // `startIn` of 1 is legal: the 20-block convention comes from the daemon's
  // `definecurrency` RPC clamping to DEFAULT_PRE_BLOSSOM_TX_EXPIRY_DELTA, and
  // consensus never checks it. Verified on testnet — a token defined at
  // 1,179,518 started at 1,179,519. The SDK builds its own transaction, so the
  // clamp does not apply here either.
  const startIn = Number.isFinite(Number(params.startIn))
    ? Math.max(1, Math.floor(Number(params.startIn)))
    : CONFIRMATIONS_AHEAD;

  const base = {
    name: String(params.name ?? '').replace(/@$/, ''),
    parent,
    startBlock: tip + startIn,
  };

  if (reserves.length === 0) {
    const supply = String(params.supply ?? params.initialSupply ?? '');
    if (!supply) throw new Error('a token needs a supply');

    // A TOKEN'S SUPPLY IS ITS PREALLOCATIONS, NOT `initialSupply`.
    //
    // The chain reads `initialSupply` only for a fractional basket. Setting it
    // on a token is accepted, costs the full 200 registration fee, and creates
    // a currency with **zero supply** — permanently, since the defining
    // identity can never define a second one. That is not hypothetical: it is
    // what `launchy` is.
    //
    // The recipient must be the identity's `i…` address; the friendly name is
    // refused.
    progress('resolving the defining identity…');
    const holder = await rpc(net.node, 'getidentity', [asIdentityRef(base.name)]);
    const recipient = holder?.identity?.identityaddress;
    if (!recipient) throw new Error(`no identity called "${base.name}@" — register it first`);

    return {
      ...base,
      kind: 'token',
      // 1 is decentralized: the supply is fixed at definition and nobody can
      // mint more, ever. 2 would leave the defining identity able to print.
      proofProtocol: 1,
      preallocations: [{ recipient, amount: parseCoins(supply) }],
    };
  }

  if (reserves.length < 2) {
    throw new Error('a basket needs at least two reserves; one reserve is a fixed price, not a market');
  }

  const ids = [];
  for (const name of reserves) ids.push(await currencyId(net, name));

  // WEIGHTS ARE SATOSHIS, NOT FRACTIONS.
  //
  // A half is `"50000000"`, and the vector must sum to exactly `100000000`.
  // Passing `"0.50000000"` — the same number written as a fraction — is
  // refused with `weights[0]: "0.50000000" is not a decimal number of
  // satoshis`. Callers hand fractions in because that is how humans say it;
  // the scaling happens here, once.
  const WEIGHT_TOTAL = 100_000_000;

  let shares;
  if (Array.isArray(params.weights) && params.weights.length === ids.length) {
    shares = params.weights.map((w) => Math.round(Number(w) * WEIGHT_TOTAL));
  } else {
    shares = ids.map(() => Math.floor(WEIGHT_TOTAL / ids.length));
  }

  if (shares.some((s) => !Number.isFinite(s) || s <= 0)) {
    throw new Error('every reserve needs a weight above zero');
  }

  // The rounding has to land somewhere: thirds do not divide into 100000000,
  // and the chain rejects a vector that misses the total by even one satoshi.
  shares[shares.length - 1] += WEIGHT_TOTAL - shares.reduce((a, b) => a + b, 0);
  const weights = shares.map((s) => String(s));

  return {
    ...base,
    kind: 'fractional',
    initialSupply: parseCoins(String(params.initialSupply ?? params.supply ?? '1000')),
    currencies: ids,
    weights,
  };
}

const idCache = new Map();
async function currencyId(net, nameOrId) {
  const cacheKey = `${net.label}:${nameOrId}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  const def = await rpc(net.node, 'getcurrency', [String(nameOrId)]);
  if (!def?.currencyid) throw new Error(`no currency called "${nameOrId}" on ${net.label}`);
  idCache.set(cacheKey, def.currencyid);
  return def.currencyid;
}

/** Stage two: the transaction exists. Show what it actually is. */
function renderBuilt(request, net, built) {
  const v = built.value;
  const status = el('div', { class: 'status' });

  const rows = [row('txid', v.txid)];
  if (built.kind === 'launch') {
    rows.push(row('currency id', v.currencyId));
    rows.push(row('starts at block', String(v.startBlock)));
    rows.push(row('launch fee', `${formatCoins(v.launchFee)} ${net.native} — burned`));
  } else if (built.kind === 'commit') {
    rows.push(row('claiming', `${built.name}@`));
    rows.push(row('registration fee', `${formatCoins(v.registrationFee)} ${net.native}`));
  } else if (built.kind === 'register') {
    rows.push(row('name', `${v.name}@`));
    rows.push(row('identity address', v.identityAddress));
    rows.push(row('fee paid', `${formatCoins(v.feePaid)} ${net.native}`));
  } else {
    if (v.fee) rows.push(row('miner fee', `${formatCoins(v.fee)} ${net.native}`));
    if (v.change) rows.push(row('change', `${formatCoins(v.change)} ${net.native}`));
  }

  const send = el('button', { type: 'button' }, 'broadcast');
  const drop = el('button', { type: 'button', class: 'secondary' }, 'discard');

  drop.addEventListener('click', () => reject('the transaction was discarded before broadcast'));
  send.addEventListener('click', async () => {
    send.disabled = true;
    drop.disabled = true;
    mount(status, el('span', { class: 'muted' }, 'broadcasting…'));
    try {
      const txid = await broadcast(net.node, v.hex);
      mount(status, el('span', { class: 'accent' }, `sent: ${txid}`));

      // Only once the reveal is on the wire is the commitment spent and the
      // salt no longer needed. Forgetting any earlier would make the fee
      // unrecoverable; a failed broadcast deliberately leaves it in place so
      // the registration can be retried.
      if (built.kind === 'register') await forget(net.label, built.name);

      await chrome.runtime.sendMessage({
        type: 'wallet:approval-result',
        id,
        result: {
          txid,
          ...(built.kind === 'launch' ? { currencyId: v.currencyId } : {}),
          ...(built.kind === 'commit' ? { state: 'awaitingCommitment', name: built.name } : {}),
          ...(built.kind === 'register'
            ? { state: 'registered', name: built.name, identityAddress: v.identityAddress }
            : {}),
        },
      });
      setTimeout(() => window.close(), 1200);
    } catch (error) {
      mount(status, el('span', { class: 'danger' }, error?.message ?? 'the node refused it'));
      send.disabled = false;
      drop.disabled = false;
    }
  });

  mount(
    root,
    el('div', { class: 'origin' }, [el('div', { class: 'small' }, 'requested by'), el('div', {}, request.origin)]),
    panel('built — nothing has been sent yet', rows),
    el('p', { class: 'muted small' }, 'The transaction is signed and sitting in this window. Nothing reaches the chain until you broadcast.'),
    el('div', { class: 'buttons' }, [drop, send]),
    status,
  );
}

async function reject(message) {
  await chrome.runtime.sendMessage({
    type: 'wallet:approval-result',
    id,
    error: { code: 4001, message },
  });
  window.close();
}

boot().catch((error) => {
  mount(root, panel('error', [el('p', { class: 'danger' }, error?.message ?? String(error))]));
});
