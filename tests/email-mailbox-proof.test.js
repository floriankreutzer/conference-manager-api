import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createEmailCodeProofFactory, createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';

const first = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const third = '10000000-0000-4000-8000-000000000003';
const configuration = { secret: 'synthetic-mailbox-proof-key-only-for-tests-001', environment: 'int',
  codeFactory: () => '00001234', browserTokenFactory: () => 'b'.repeat(43) };
const context = { challengeId: first, mailboxId: second };

test('mailbox proof binds environment, purpose, challenge and independently resolved mailbox without Tenant authority', () => {
  const factory = createEmailMailboxProofFactory(configuration), proof = factory.issue(context);
  assert.equal(proof.code, '00001234'); assert.equal(factory.matches({ context, ...proof }), true);
  for (const changed of [{ ...context, challengeId: third }, { ...context, mailboxId: third }]) {
    assert.equal(factory.matches({ context: changed, ...proof }), false);
  }
  for (const environment of ['dev', 'prod']) {
    assert.equal(createEmailMailboxProofFactory({ ...configuration, environment }).matches({ context, ...proof }), false);
  }
  assert.equal(factory.matches({ context, ...proof, browserToken: 'c'.repeat(43) }), false);
  assert.equal(factory.matches({ context, ...proof, code: '00001235' }), false);
  assert.equal(factory.matches({ context, ...proof, codeVerifier: proof.browserVerifier }), false);
  assert.doesNotMatch(JSON.stringify(proof), /tenantId|userId|role|membership|permission/);
});

test('existing Tenant/User HMAC remains byte-compatible and cannot be substituted for mailbox proof', () => {
  const tenant = { challengeId: first, tenantId: second, userId: third };
  const proof = createEmailCodeProofFactory(configuration).issue(tenant);
  const expected = createHmac('sha256', configuration.secret)
    .update(`email-code:v1:int:code:${first}:${second}:${third}:00001234`, 'ascii').digest('hex');
  assert.equal(proof.codeVerifier, expected);
  assert.equal(createEmailMailboxProofFactory(configuration).matches({ context, ...proof }), false);
  assert.throws(() => createEmailMailboxProofFactory(configuration).issue(tenant), /CONTEXT_INVALID/);
  assert.throws(() => createEmailCodeProofFactory(configuration).issue(context), /CONTEXT_INVALID/);
});

test('unknown/accessor/hidden/prototype context and malformed proofs fail closed without evaluating getters', () => {
  let reads = 0;
  const accessor = { ...context };
  Object.defineProperty(accessor, 'mailboxId', { enumerable: true, get() { reads++; return second; } });
  const hidden = { ...context }; Object.defineProperty(hidden, 'private', { value: true });
  const symbol = { ...context }; symbol[Symbol('hidden')] = true;
  const factory = createEmailMailboxProofFactory(configuration), proof = factory.issue(context);
  for (const value of [accessor, hidden, symbol, Object.create(context), { ...context, tenantId: third },
    { ...context, mailboxId: null }, null]) assert.throws(() => factory.issue(value), /CONTEXT_INVALID/);
  for (const extra of [{ code: 1234 }, { code: '00001234\n' }, { codeVerifier: 'not-a-verifier' }, { browserVerifier: null }]) {
    assert.equal(factory.matches({ context, ...proof, ...extra }), false);
  }
  assert.equal(reads, 0);
});
