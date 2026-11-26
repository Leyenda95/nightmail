// Which client transactions the payer agrees to pay for: only contract calls that move no value. The wallet
// signer (signRecipe) signs every unsigned unshielded input regardless of owner, so an unshielded offer
// spending the operator's NIGHT would walk away with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Intent, sampleIntentHash, sampleSigningKey, sampleUserAddress, signatureVerifyingKey, Transaction, unshieldedToken,
  UnshieldedOffer,
} from '@midnightntwrk/ledger-v9';
import { relayProblem } from '../src/chain/relayable.ts';

const TTL = new Date(Date.now() + 60_000);
const NIGHT = unshieldedToken().raw;
/** Someone else's NIGHT UTXO (e.g. the operator's: its UTXOs and key are public). */
const SPEND = { value: 1_000n, owner: signatureVerifyingKey(sampleSigningKey()), type: NIGHT, intentHash: sampleIntentHash(), outputNo: 0 };
const OUTPUT = { value: 1_000n, owner: sampleUserAddress(), type: NIGHT };
const theft = () => UnshieldedOffer.new([SPEND], [OUTPUT], []);

/** A real ledger-v9 transaction with an intent that `edit` can fill in. */
function txWith(edit: (intent: ReturnType<typeof Intent.new>) => void = () => {}) {
  const intent = Intent.new(TTL);
  edit(intent);
  return Transaction.fromParts('undeployed', undefined, undefined, intent);
}

test('relayable: contract calls without offers or DUST actions (what the client sends) are paid', () => {
  assert.equal(relayProblem({ intents: new Map([[1, { actions: [{}] }]]) }), null);
  assert.equal(relayProblem({ intents: new Map([[1, { actions: [] }], [2, { actions: [{}, {}] }]]) }), null);
});

test('relayable: a real ledger-v9 intent without actions is not a contract call', () => {
  assert.equal(relayProblem(txWith()), 'no-call');
});

test('relayable: a guaranteed unshielded offer is not paid (it would be signed with the operator key)', () => {
  assert.equal(relayProblem(txWith((i) => { i.guaranteedUnshieldedOffer = theft(); })), 'unshielded-offer');
});

test('relayable: a fallible unshielded offer is not paid either', () => {
  assert.equal(relayProblem(txWith((i) => { i.fallibleUnshieldedOffer = theft(); })), 'unshielded-offer');
});

test('relayable: client DUST actions (spends or registrations) are not paid', () => {
  const tx = { intents: new Map([[1, { dustActions: {} }]]) };
  assert.equal(relayProblem(tx), 'dust-actions');
});

test('relayable: Zswap (shielded) offers, guaranteed or fallible, are not paid', () => {
  assert.equal(relayProblem({ guaranteedOffer: {} }), 'zswap-offer');
  assert.equal(relayProblem({ fallibleOffer: new Map([[1, {}]]) }), 'zswap-offer');
});

test('relayable: every intent is checked, not only the first', () => {
  const tx = { intents: new Map<number, object>([[1, {}], [2, { fallibleUnshieldedOffer: {} }]]) };
  assert.equal(relayProblem(tx), 'unshielded-offer');
});

test('relayable: without intents (nothing to pay) it is not a contract call either', () => {
  assert.equal(relayProblem({}), 'no-call');
  assert.equal(relayProblem({ intents: new Map() }), 'no-call');
  assert.equal(relayProblem({ intents: new Map([[1, {}]]) }), 'no-call', 'an intent without actions');
});

test('relayable: anything that moves value is caught even when there are calls too', () => {
  const tx = { intents: new Map([[1, { actions: [{}], guaranteedUnshieldedOffer: {} }]]) };
  assert.equal(relayProblem(tx), 'unshielded-offer');
});
