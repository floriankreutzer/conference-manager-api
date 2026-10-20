import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCustomerMicrosoftFlowBinding } from '../src/identity/customer-microsoft-flow-binding.js';
const secret='s'.repeat(48),state='S'.repeat(43),flowId='b1000000-0000-4000-8000-000000000001';
const configuration={ secret,environment: 'int',randomToken: ()=>state };
const context={ flowId,purpose: 'login',stage: 'authorization' };
const hash=value=>createHash('sha256').update(value).digest('hex');

test('Microsoft protocol recovers exact expected nonce and S256 verifier across instances without plaintext storage',()=>{
  const first=createCustomerMicrosoftFlowBinding(configuration),second=createCustomerMicrosoftFlowBinding(configuration);
  const started=first.issueState({ purpose: 'login' });assert.deepEqual(second.protocol({ state,purpose: 'login' }),started);
  assert.equal(started.stateHash,hash(state));assert.equal(started.nonceHash,hash(started.nonce));
  for (const field of ['state','nonce','codeVerifier','codeChallenge']) assert.match(started[field],/^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set([started.state,started.nonce,started.codeVerifier,started.codeChallenge]).size,4);
  assert.equal(started.codeChallenge,createHash('sha256').update(started.codeVerifier).digest('base64url'));
  for (const changed of [{ ...configuration,environment: 'prod' },{ ...configuration,secret: 't'.repeat(48) }]) {
    const other=createCustomerMicrosoftFlowBinding(changed).protocol({ state,purpose: 'login' });
    assert.notEqual(other.nonce,started.nonce);assert.notEqual(other.codeVerifier,started.codeVerifier);
  }
  assert.notEqual(second.protocol({ state,purpose: 'link' }).nonce,started.nonce);
});
test('browser and explicit CSRF binding require exact flow, purpose, stage, environment and secret',()=>{
  const first=createCustomerMicrosoftFlowBinding(configuration),second=createCustomerMicrosoftFlowBinding(configuration);
  const issued=first.issueBrowser(context);assert.equal(second.matchesBrowser({ context,...issued }),true);
  assert.equal(second.verifyCsrf({ context,...issued }),true);
  assert.notEqual(issued.browserToken,issued.browserVerifier);assert.notEqual(issued.browserVerifier,issued.csrfToken);
  assert.equal(second.csrfFor({ context,browserVerifier: issued.browserVerifier }),issued.csrfToken);
  for (const changed of [{ ...context,flowId: 'b1000000-0000-4000-8000-000000000002' },
    { ...context,purpose: 'link' },{ ...context,stage: 'choice' }]) {
    assert.equal(second.matchesBrowser({ context: changed,...issued }),false);
    assert.equal(second.verifyCsrf({ context: changed,...issued }),false);
  }
  for (const changed of [{ ...configuration,environment: 'prod' },{ ...configuration,secret: 't'.repeat(48) }]) {
    const other=createCustomerMicrosoftFlowBinding(changed);
    assert.equal(other.matchesBrowser({ context,...issued }),false);assert.equal(other.verifyCsrf({ context,...issued }),false);
  }
  assert.equal(second.matchesBrowser({ context,...issued,browserToken: 'invalid' }),false);
  assert.equal(second.verifyCsrf({ context,...issued,csrfToken: 'invalid' }),false);
  assert.equal(second.verifyCsrf({ context,...issued,browserVerifier: 'invalid' }),false);
});
test('closed context/protocol shapes, invalid entropy/configuration and destroyed custody fail closed',()=>{
  const binding=createCustomerMicrosoftFlowBinding(configuration);
  for (const value of [{ ...context,tenantId: flowId },{ ...context,flowId: '../foreign' },
    { ...context,purpose: 'admin' },{ ...context,stage: 'confirmation' }]) assert.throws(()=>binding.issueBrowser(value),/BINDING_INVALID/);
  for (const value of [{ state,purpose: 'login',nonce: state },{ state: 'short',purpose: 'login' },{ state,purpose: 'admin' }]) {
    assert.throws(()=>binding.protocol(value),/BINDING_INVALID/);
  }
  for (const value of [{ secret: 'short' },{ environment: 'unknown' },{ secret: ' '+secret },{ randomToken: null }]) {
    assert.throws(()=>createCustomerMicrosoftFlowBinding({ ...configuration,...value }),/BINDING_INVALID/);
  }
  assert.throws(()=>createCustomerMicrosoftFlowBinding({ ...configuration,randomToken: ()=> 'short' })
    .issueState({ purpose: 'login' }),/BINDING_INVALID/);
  binding.destroy();assert.throws(()=>binding.issueState({ purpose: 'login' }),/UNAVAILABLE/);
  assert.throws(()=>binding.issueBrowser(context),/UNAVAILABLE/);
});
