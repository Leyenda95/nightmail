// TestToken in the simulator: mints to the caller, with the token color and the requested nonce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, pureCircuits } from '../managed/token-sim/contract/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const rand = () => new Uint8Array(randomBytes(32));
const DEPLOYER_PK = 'd0'.repeat(32);
const USER_PK = 'c0'.repeat(32);

async function deploy() {
  const contract = new Contract<{}>({});
  const address = sampleContractAddress();
  const state = (await contract.initialState(createConstructorContext({}, DEPLOYER_PK))).currentContractState.data;
  const run = async (circuit: string, ...args: unknown[]) => {
    const cx: any = createCircuitContext({
      circuitId: circuit, contractAddress: address, coinPublicKeyOrZswapState: USER_PK,
      contractState: state, privateState: {},
    } as any);
    return (contract.impureCircuits as any)[circuit](cx, ...args);
  };
  return { run, color: pureCircuits.colorOf({ bytes: Buffer.from(address, 'hex') }) as Uint8Array };
}

test('mint mints the requested amount, of the token color, with the requested nonce, to the caller', async () => {
  const t = await deploy();
  const color = t.color; // colorOf(token address), computed off chain
  const nonce = rand();
  const r = await t.run('mint', 300n, nonce);
  const coin = r.result;
  assert.equal(coin.value, 300n);
  assert.equal(hex(coin.color), hex(color));
  assert.equal(hex(coin.nonce), hex(nonce));
  const outs = r.context.callContext.currentZswapLocalState.outputs;
  assert.equal(outs.length, 1);
  assert.equal(outs[0].recipient.is_left, true, 'the recipient is a user key');
  assert.equal(hex(outs[0].recipient.left.bytes), USER_PK, 'the caller, not the deployer');
  assert.equal(hex(outs[0].coinInfo.nonce), hex(nonce));
  assert.equal(outs[0].coinInfo.value, 300n);
});

test('two deployments of the token have different colors', async () => {
  assert.notEqual(hex((await deploy()).color), hex((await deploy()).color));
});
