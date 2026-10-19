import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';

const id = number => `d0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const configuration = { environment: 'int',secret: 'synthetic-email-flow-binding-key-test-only-00001' };
const context = { challengeId: id(1),purpose: 'request' };

test('admitted and unadmitted flow bindings have the same browser/CSRF shape without mailbox or Tenant authority', () => {
  const factory = createCustomerEmailFlowBinding(configuration), first = factory.issue(context), second = factory.issue(context);
  assert.equal(Object.isFrozen(first),true); assert.notEqual(first.browserToken,second.browserToken);
  assert.equal(factory.matchesBrowser({ context,...first }),true); assert.equal(factory.verifyCsrf({ context,...first }),true);
  assert.match(first.browserToken,/^[A-Za-z0-9_-]{43}$/); assert.match(first.csrfToken,/^[a-f0-9]{64}$/);
  assert.equal(factory.csrfFor({ context,browserVerifier: first.browserVerifier }),first.csrfToken);
  assert.doesNotMatch(JSON.stringify(first),/mailbox|tenantId|userId|role|membership|permission/);
  assert.equal(factory.matchesBrowser({ context,...first,browserToken: second.browserToken }),false);
  assert.equal(factory.verifyCsrf({ context,...first,csrfToken: second.csrfToken }),false);
});

test('the same server-issued mailbox-proof browser token also binds the pending flow without conflating code and CSRF evidence', () => {
  const proof = createEmailMailboxProofFactory(configuration).issue({ challengeId: id(1),mailboxId: id(2) });
  const factory = createCustomerEmailFlowBinding(configuration), flow = factory.bind(context,proof.browserToken);
  assert.equal(factory.matchesBrowser({ context,browserToken: proof.browserToken,...flow }),true);
  assert.equal(factory.verifyCsrf({ context,...flow }),true);
  assert.notEqual(proof.browserVerifier,flow.browserVerifier);
  assert.notEqual(proof.codeVerifier,flow.browserVerifier); assert.notEqual(proof.codeVerifier,flow.csrfToken);
  assert.equal(factory.verifyCsrf({ context,...flow,csrfToken: proof.codeVerifier }),false);
});

test('challenge, environment, secret and request/choice substitution fail; choice uses a fresh independent browser token', () => {
  const factory = createCustomerEmailFlowBinding(configuration), flow = factory.issue(context);
  for (const changed of [{ ...context,challengeId: id(2) },{ ...context,purpose: 'choice' }]) {
    assert.equal(factory.matchesBrowser({ context: changed,...flow }),false);
    assert.equal(factory.verifyCsrf({ context: changed,...flow }),false);
  }
  for (const changed of [{ ...configuration,environment: 'prod' },{ ...configuration,secret: `${configuration.secret}-other` }]) {
    assert.equal(createCustomerEmailFlowBinding(changed).matchesBrowser({ context,...flow }),false);
    assert.equal(createCustomerEmailFlowBinding(changed).verifyCsrf({ context,...flow }),false);
  }
  const choice = factory.issue({ ...context,purpose: 'choice' }); assert.notEqual(flow.browserToken,choice.browserToken);
  assert.equal(factory.matchesBrowser({ context: { ...context,purpose: 'choice' },...choice }),true);
});

test('malformed, noncanonical, hidden/accessor/prototype scope and destroyed custody never authenticate', () => {
  const factory = createCustomerEmailFlowBinding(configuration), flow = factory.issue(context);
  let reads = 0; const accessor = { ...context };
  Object.defineProperty(accessor,'purpose',{ enumerable: true,get() { reads++; return 'request'; } });
  for (const value of [null,Object.create(context),accessor,{ ...context,mailboxId: id(2) },{ ...context,purpose: 'session' }]) {
    assert.throws(() => factory.issue(value),/INVALID/);
  }
  const canonical = Buffer.alloc(32,1).toString('base64url');
  const changed = canonical.slice(0,-1)+String.fromCharCode(canonical.charCodeAt(canonical.length-1)+1);
  assert.equal(Buffer.from(changed,'base64url').equals(Buffer.from(canonical,'base64url')),true);
  for (const browserToken of ['short',`${canonical}=`,changed,null]) {
    assert.equal(factory.matchesBrowser({ context,...flow,browserToken }),false);
    assert.throws(() => factory.bind(context,browserToken),/INVALID/);
  }
  assert.equal(reads,0); factory.destroy(); factory.destroy();
  for (const invoke of [() => factory.issue(context),() => factory.bind(context,canonical),
    () => factory.matchesBrowser({ context,...flow }),() => factory.verifyCsrf({ context,...flow })]) {
    assert.throws(invoke,/UNAVAILABLE/);
  }
});
