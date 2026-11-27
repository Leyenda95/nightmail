// Compact simulator harness for NightMailRegistry (no ZK proofs).
// Each test deploys a fresh contract; witnesses read the call's private state.
import { randomBytes } from 'node:crypto';
import {
  ContractState, CostModel, createCircuitContext, createConstructorContext, QueryContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, Kind, ledger, Plan, pureCircuits as pc } from '../managed/registry-sim/contract/index.js';

export { Kind, Plan, pc };
export const NO_EXPIRY = 2n ** 32n - 1n; // max Uint<32>, same as noExpiry()
export const PRICE = 100n;
/** Block time (Unix seconds) each simulator deployment starts at; moved with setTime. */
export const T0 = 1_800_000_000n;
export const NAME_BYTES = 64;
export const NAME_CIPHER_BYTES = 104; // nonce 24 + name 64 + tag 16 (XChaCha20-Poly1305)
export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const rand = (n = 32) => new Uint8Array(randomBytes(n));
/** Normalized name zero-padded to 64 bytes (normalization is the app's job). */
export const nameBytes = (name: string) => {
  const out = new Uint8Array(NAME_BYTES);
  out.set(new TextEncoder().encode(name));
  return out;
};

/** What the app knows about a bono: its secret and, per leaf, its index k, plan and expiry. */
export type Bono = { s: Uint8Array; k: bigint; plan: Plan; validUntil: bigint };
// pathOf / path: only for attacks and edge cases (another leaf, or a path computed earlier).
type PrivateState = { bono: Bono; j: bigint; opSk: Uint8Array; pathOf?: Uint8Array; path?: unknown };

const COIN_PK = '0'.repeat(64);

export async function deploy(opts: { color?: Uint8Array; price?: bigint; opPk?: Uint8Array } = {}) {
  const opSk = rand();
  const paymentColor = opts.color ?? rand();
  const positions = new Map<string, bigint>(); // leaf -> position (insertHash does not look up by value)
  // A leaf with no recorded position is a test bug (attacks pass pathOf or path instead).
  const pathFor = (tree: any, leaf: Uint8Array) => {
    const pos = positions.get(hex(leaf));
    if (pos === undefined) throw new Error(`test harness: leaf ${hex(leaf).slice(0, 8)}… was never issued here`);
    return tree.pathForLeaf(pos, leaf);
  };
  const witnesses = {
    bonoSecret: (c: any) => [c.privateState, c.privateState.bono.s],
    bonoLeafIndex: (c: any) => [c.privateState, c.privateState.bono.k],
    bonoPlan: (c: any) => [c.privateState, c.privateState.bono.plan],
    bonoValidUntil: (c: any) => [c.privateState, c.privateState.bono.validUntil],
    slotIndex: (c: any) => [c.privateState, c.privateState.j],
    bonoPath: (c: any, leaf: Uint8Array) => {
      const ps: PrivateState = c.privateState;
      return [ps, ps.path ?? pathFor(c.ledger.bonos, ps.pathOf ?? leaf)];
    },
    operatorSecret: (c: any) => [c.privateState, c.privateState.opSk],
  };
  const contract = new Contract<PrivateState>(witnesses as any);
  const address = sampleContractAddress();
  const ctx = pc.ctxOf({ bytes: Buffer.from(address, 'hex') });
  const blank: PrivateState = { bono: { s: rand(), k: 0n, plan: Plan.free, validUntil: NO_EXPIRY }, j: 0n, opSk };
  const init = await contract.initialState(createConstructorContext(blank, COIN_PK),
    opts.opPk ?? pc.operatorKey(opSk), paymentColor, opts.price ?? PRICE);
  let state = init.currentContractState.data;
  let now = T0; // block time seen by the circuits (blockTimeLt and friends)

  /** Runs a circuit and returns everything (result, context, transcript). */
  async function runFull(circuit: string, ps: Partial<PrivateState>, ...args: unknown[]) {
    const cx: any = createCircuitContext({
      circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: COIN_PK,
      contractState: state, privateState: { ...blank, ...ps }, time: Number(now),
    } as any);
    const r: any = await (contract.impureCircuits as any)[circuit](cx, ...args);
    state = r.context.callContext.currentQueryContext.state;
    return r;
  }
  const run = async (circuit: string, ps: Partial<PrivateState>, ...args: unknown[]) =>
    (await runFull(circuit, ps, ...args)).result;
  /** Like runFull but without applying the result: a proven transaction not yet submitted. */
  async function prove(circuit: string, ps: Partial<PrivateState>, ...args: unknown[]) {
    const before = state;
    try {
      return await runFull(circuit, ps, ...args);
    } finally {
      state = before;
    }
  }
  /**
   * What the node does with a proven transaction arriving now: replays its public transcript in
   * verification mode against the current state and block time. Throws if anything it read while
   * proving has changed (the node would reject it before the block, without a fee).
   */
  function verifyNow(proved: any): void {
    const call = proved.context.callProofDataTrace.at(-1);
    let q = new QueryContext(state, address);
    q.block = { ...call.initialQueryContext.block, secondsSinceEpoch: now };
    for (const [commitment, index] of call.finalQueryContext.comIndices) q = q.insertCommitment(commitment, index);
    const gas = { readTime: 10n ** 12n, computeTime: 10n ** 12n, bytesWritten: 10n ** 9n, bytesDeleted: 0n };
    q.runTranscript({ gas, effects: call.finalQueryContext.effects, program: call.publicTranscript }, CostModel.initialCostModel());
  }
  const view = () => ledger(state);

  const leafOf = (b: Bono) => pc.bonoLeaf(ctx, pc.bonoId(ctx, b.s, b.k), b.plan, b.validUntil);
  /** The app computes its leaf and records its position before the contract inserts it. */
  const expectLeaf = (b: Bono) => positions.set(hex(leafOf(b)), view().bonos.firstFree());
  const slotNul = (b: Bono, kind: Kind, j: bigint) => pc.slotNullifier(ctx, b.s, kind, j, 0n);

  const ops = {
    ctx, address, paymentColor, opSk, view, run, runFull, prove, verifyNow, leafOf, slotNul,
    pathNow: (b: Bono) => pathFor(view().bonos, leafOf(b)),
    /** Attack: a path at the position of a real leaf claiming to be the leaf of `forged`. */
    pathClaiming: (real: Bono, forged: Bono) =>
      view().bonos.pathForLeaf(positions.get(hex(leafOf(real)))!, leafOf(forged)),
    /** The operator issues leaf k of a bono (free, or paid by simulated card). */
    async issue(plan: Plan, s = rand(), k = 0n): Promise<Bono> {
      const b: Bono = { s, k, plan, validUntil: NO_EXPIRY };
      expectLeaf(b);
      await run('issueBono', { opSk }, pc.bonoId(ctx, s, k), plan);
      return b;
    },
    /** The user buys leaf k of a paid bono with the shielded token. */
    async buy(coin = { nonce: rand(), color: paymentColor, value: PRICE }, s = rand(), k = 0n): Promise<Bono> {
      const b: Bono = { s, k, plan: Plan.paid, validUntil: NO_EXPIRY };
      expectLeaf(b);
      await run('buyBono', {}, coin, pc.bonoId(ctx, s, k));
      return b;
    },
    /** Alias keys and the address they map to when spending slot (b, j). */
    aliasFor(b: Bono, j: bigint, keys = { encPk: rand(), authPk: rand() }) {
      return { ...keys, bono: b, j, addrKey: pc.aliasKey(keys.encPk, keys.authPk, slotNul(b, Kind.alias, j)) };
    },
    createAlias(a: { bono: Bono; j: bigint; encPk: Uint8Array; authPk: Uint8Array }, extra: Partial<PrivateState> = {}) {
      return run('createAlias', { bono: a.bono, j: a.j, ...extra }, a.encPk, a.authPk);
    },
    alias(b: Bono, j: bigint, keys?: { encPk: Uint8Array; authPk: Uint8Array }) {
      const a = ops.aliasFor(b, j, keys);
      return ops.createAlias(a).then(() => a);
    },
    /** A mailbox that will spend slot (b, j): its data, computed as the app does. */
    mailbox(name: string, b: Bono, j: bigint) {
      const m = {
        name: nameBytes(name), encPk: rand(), authPk: rand(),
        nameCipher: rand(NAME_CIPHER_BYTES), bono: b, j, slotNul: slotNul(b, Kind.mailbox, j),
      };
      return { ...m, addrKey: pc.addressKey(m.name) };
    },
    /** The current state as a ContractState (data only, as the indexer's state bytes decode). */
    contractState() {
      const cs = new ContractState();
      cs.data = state;
      return cs;
    },
    /** Raw state shape: number of fields in each subarray the compiler splits them into. */
    stateShape: () => state.state.asArray()!.map((part: any) => part.asArray()!.length),
    /** Block time (Unix seconds) for subsequent calls. */
    time: () => now,
    setTime(t: bigint) {
      now = t;
    },
    /** The operator changes the price; the old one is accepted until `until` (default: minimum window). */
    setPrice(newPrice: bigint, until = now + pc.oldPriceGrace(), sk = opSk) {
      return run('setPrice', { opSk: sk }, newPrice, until);
    },
    /** Buys with a fresh coin of that amount (to test which prices are accepted). */
    pay(value: bigint) {
      return ops.buy({ nonce: rand(), color: paymentColor, value });
    },
    /** Registers a mailbox in one transaction (registerMailbox). */
    register(m: { bono: Bono; j: bigint; name: Uint8Array; encPk: Uint8Array; authPk: Uint8Array; nameCipher: Uint8Array },
      extra: Partial<PrivateState> = {}) {
      return run('registerMailbox', { bono: m.bono, j: m.j, ...extra }, m.name, m.encPk, m.authPk, m.nameCipher);
    },
  };
  return ops;
}
