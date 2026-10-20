import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeSyntheticHandoffScope,normalizeSyntheticHandoffIntent,normalizeSyntheticHandoffSelection,
  syntheticHandoffOperationHash,syntheticDelegationIdentityReference,SYNTHETIC_HANDOFF_ROLES,SYNTHETIC_HANDOFF_SLOTS }
  from '../src/domain/synthetic-handoff.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createSyntheticGenerationPlanner } from '../src/tenancy/synthetic-generation-plan.js';

const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://localhost' };
const selection={ flowId: randomUUID(),operatorId: randomUUID(),generationId: randomUUID(),slot: 'northwind',role: 'tenant_admin' };
function factory(changes={}) {
  let counter=0;
  return createSyntheticHandoffBrowserBinding({ secret: 'h'.repeat(48),scope,
    randomToken: ()=>Buffer.alloc(32,++counter).toString('base64url'),...changes });
}

test('closed handoff selection stays aligned with the actual generated three-customer persona contract',()=>{
  const plan=createSyntheticGenerationPlanner().create({ environment: 'int',securityEpoch: scope.securityEpoch,
    operatorId: selection.operatorId,operatorSecurityVersion: 1,now: new Date() });
  assert.deepEqual(plan.tenants.map(tenant=>tenant.slot),[...SYNTHETIC_HANDOFF_SLOTS]);
  for (const tenant of plan.tenants) assert.deepEqual(tenant.users.map(user=>user.role),[...SYNTHETIC_HANDOFF_ROLES]);
  assert.deepEqual(normalizeSyntheticHandoffSelection({ ...selection,operatorId: selection.operatorId.toUpperCase() }),selection);
  assert.throws(()=>syntheticDelegationIdentityReference(selection),/INVALID/);
});

test('exact proof digest binds both deployment origins, epochs, owner, generation, known role, slot and immutable initiating browser',()=>{
  const binding={ flowId: selection.flowId,stateHash: 'a'.repeat(64),browserVerifier: 'b'.repeat(64) };
  const hash=syntheticHandoffOperationHash(scope,selection,binding);assert.match(hash,/^[a-f0-9]{64}$/);
  assert.equal(syntheticHandoffOperationHash({ ...scope,securityEpoch: scope.securityEpoch.toUpperCase() },selection,binding),hash);
  for (const change of [{ environment: 'dev' },{ securityEpoch: randomUUID() },{ customerOrigin: 'https://127.0.0.2' },
    { platformOrigin: 'https://localhost:8443' },{ platformSecurityEpoch: 8 }]) {
    assert.notEqual(syntheticHandoffOperationHash({ ...scope,...change },selection,binding),hash);
  }
  for (const change of [{ operatorId: randomUUID() },{ generationId: randomUUID() },{ slot: 'fabrikam' },{ role: 'employee' }]) {
    assert.notEqual(syntheticHandoffOperationHash(scope,{ ...selection,...change },binding),hash);
  }
  for (const change of [{ stateHash: 'c'.repeat(64) },{ browserVerifier: 'd'.repeat(64) }]) {
    assert.notEqual(syntheticHandoffOperationHash(scope,selection,{ ...binding,...change }),hash);
  }
  assert.throws(()=>syntheticHandoffOperationHash(scope,selection,{ ...binding,flowId: randomUUID() }),/INVALID/);
});

test('unknown authority, accessors, symbolic/hidden fields, production and unsafe origins fail closed without executing getters',()=>{
  let reads=0;
  const accessor={ ...selection };Object.defineProperty(accessor,'operatorId',{ enumerable: true,get() { reads++;return randomUUID(); } });
  const hidden={ ...selection };Object.defineProperty(hidden,'tenantId',{ value: randomUUID() });
  const symbol={ ...selection };symbol[Symbol('authority')]=true;
  for (const value of [accessor,hidden,symbol,{ ...selection,tenantId: randomUUID() },{ ...selection,role: 'platform_admin' },
    { ...selection,slot: 'foreign' },Object.create(selection),[],null]) {
    assert.throws(()=>normalizeSyntheticHandoffSelection(value),/INVALID/);
  }
  assert.equal(reads,0);
  for (const change of [{ environment: 'prod' },{ platformSecurityEpoch: 0 },
    { customerOrigin: 'http://127.0.0.1' },{ platformOrigin: scope.customerOrigin },
    { customerOrigin: 'https://127.0.0.1/' },{ platformOrigin: 'https://user@localhost' },{ customerOrigin: 'https://127.0.0.1/?x=1' }]) {
    assert.throws(()=>normalizeSyntheticHandoffScope({ ...scope,...change }),/INVALID/);
  }
  const intent={ ...selection,state: Buffer.alloc(32,4).toString('base64url') };
  assert.equal(normalizeSyntheticHandoffIntent(intent).state,intent.state);
  assert.throws(()=>normalizeSyntheticHandoffIntent({ ...intent,proofContext: {} }),/INVALID/);
  const identity={ generationId: selection.generationId,operatorId: selection.operatorId,role: 'employee' };
  assert.equal(syntheticDelegationIdentityReference(identity),
    `${selection.generationId}:${selection.operatorId}:employee`);
});

test('approval code and completion remain unusable outside the original browser, flow, secret, origins and UUID epoch',()=>{
  const binding=factory(),start=binding.issueStart(selection.flowId),approval=binding.issueCode(selection.flowId);
  const context={ flowId: selection.flowId,browserVerifier: start.browserVerifier,codeVerifier: approval.codeVerifier };
  const now=new Date(),expiresAt=new Date(now.getTime()+30_000);
  const complete=binding.issueCompletion({ binding: context,browserToken: start.browserToken,now,expiresAt });
  const request={ binding: context,browserToken: start.browserToken,value: complete.value,now };
  assert.equal(binding.matchesCompletion(request),true);
  assert.equal(binding.verifyCompletionCsrf({ binding: context,...complete }),true);
  assert.equal(binding.matchesCode({ flowId: selection.flowId,...approval }),true);
  assert.notEqual(start.state,start.browserToken);assert.notEqual(start.state,approval.code);
  assert.equal(binding.matchesBrowser({ flowId: selection.flowId,...start }),true);
  assert.equal(binding.stateVerifier(start.state),start.stateHash);
  for (const change of [{ secret: 'i'.repeat(48) },{ scope: { ...scope,securityEpoch: randomUUID() } },
    { scope: { ...scope,environment: 'dev' } },{ scope: { ...scope,platformOrigin: 'https://localhost:8443' } },
    { scope: { ...scope,customerOrigin: 'https://127.0.0.2' } }]) {
    const other=factory(change);
    assert.equal(other.matchesBrowser({ flowId: selection.flowId,...start }),false);
    assert.equal(other.matchesCode({ flowId: selection.flowId,...approval }),false);
    assert.equal(other.matchesCompletion(request),false);other.destroy();
  }
  const attackerNonce=Buffer.alloc(32,10).toString('base64url');
  assert.equal(binding.matchesCompletion({ ...request,browserToken: attackerNonce }),false);
  assert.throws(()=>binding.issueCompletion({ binding: context,browserToken: attackerNonce,now,expiresAt }),/INVALID/);
  assert.equal(binding.matchesCode({ flowId: randomUUID(),...approval }),false);
  const changed={ ...context,codeVerifier: 'c'.repeat(64) };
  assert.equal(binding.matchesCompletion({ ...request,binding: changed }),false);
  assert.equal(binding.verifyCompletionCsrf({ binding: changed,...complete }),false);
  binding.destroy();assert.throws(()=>binding.stateVerifier(start.state),/UNAVAILABLE/);
});

test('signed completion lifetime is short and strict; tampered expiry, nonce, signature and CSRF cannot extend it',()=>{
  const binding=factory(),start=binding.issueStart(selection.flowId),approval=binding.issueCode(selection.flowId);
  const context={ flowId: selection.flowId,browserVerifier: start.browserVerifier,codeVerifier: approval.codeVerifier };
  const now=new Date(),expiresAt=new Date(now.getTime()+30_000);
  const complete=binding.issueCompletion({ binding: context,browserToken: start.browserToken,now,expiresAt });
  const request={ binding: context,browserToken: start.browserToken,value: complete.value,now };
  assert.equal(binding.matchesCompletion({ ...request,now: expiresAt }),false);
  assert.throws(()=>binding.issueCompletion({ binding: context,browserToken: start.browserToken,now,
    expiresAt: new Date(now.getTime()+30_001) }),/INVALID/);
  const parts=complete.value.split('.');
  for (const [index,value] of [[0,randomUUID()],[1,String(now.getTime()+60_000)],
    [2,Buffer.alloc(32,8).toString('base64url')],[3,Buffer.alloc(32,8).toString('base64url')]]) {
    const changed=[...parts];changed[index]=value;const forged=changed.join('.');
    assert.equal(binding.matchesCompletion({ ...request,value: forged }),false);
    assert.equal(binding.verifyCompletionCsrf({ binding: context,value: forged,csrfToken: complete.csrfToken }),false);
    assert.throws(()=>binding.completionCsrf({ binding: context,value: forged }),/INVALID/);
  }
  assert.equal(binding.verifyCompletionCsrf({ binding: context,...complete,csrfToken: '0'.repeat(64) }),false);
  binding.destroy();
});
