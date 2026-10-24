import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createOwnerCustomerAccessProtocol } from '../src/platform/application/owner-customer-access-protocol.js';

const now=new Date().toISOString(),operatorId=randomUUID();
const roles=['platform_security_admin','platform_security_auditor','platform_support_reader','platform_tenant_operator'];
const principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
  providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'directory',subjectReference: 'subject' },
  targetScope: { mode: 'all',securityVersion: 3 },
  assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: now },
  session: { id: randomUUID(),issuedAt: now,expiresAt: new Date(Date.now()+3_600_000).toISOString(),securityVersion: 3,
    securityEpoch: 7,stepUpExpiresAt: null } };
const intent={ flowId: randomUUID(),state: Buffer.alloc(32,1).toString('base64url'),operatorId,tenantId: randomUUID(),role: 'employee' };

test('owner protocol releases short preparation before exact proof and returns only after the complete continuation commit',async()=>{
  const events=[],context=Object.freeze({ private: true }),result={ status: 'redirect',location: 'private-fixed-result' };
  let held=false,commitFailure=false;
  const protocol=createOwnerCustomerAccessProtocol({
    async withPreparationScope(work) { assert.equal(held,false);held=true;events.push('shared');
      try { return await work(); } finally { held=false;events.push('released'); } },
    handoffService: {
      async operationHash(input) {
        assert.equal(held,true);assert.deepEqual(input.intent,intent);events.push('hash');return 'a'.repeat(64);
      },
      async approve(input) { assert.equal(held,false);assert.equal(input.proofContext,context);assert.deepEqual(input.intent,intent);
        events.push('mutation');return result; },
    },microsoftOperationService: {
      async startStepUp(value,input) {
        assert.equal(held,true);assert.deepEqual(value,principal);assert.equal(input.operationHash,'a'.repeat(64));
        events.push('start');return { started: true }; },
      async executeStepUpWithContinuation(input,work) {
        assert.equal(held,false);assert.equal(input.cookie,'opaque-cookie');assert.equal(input.operationHash,'a'.repeat(64));
        events.push('operation');const value=await work(context);events.push('commit');
        if (commitFailure) throw new Error('ACTUAL_COMMIT_FAILURE');return { committed: value };
      },
    },
  });
  const input={ principal,intent,correlationId: randomUUID(),cookie: 'opaque-cookie',state: 'opaque-state',request: {} };
  assert.deepEqual(await protocol.options(input),{ started: true });assert.deepEqual(events,['shared','hash','start','released']);
  events.length=0;assert.deepEqual(await protocol.approve(input),{ committed: result });
  assert.deepEqual(events,['shared','hash','released','operation','mutation','commit']);
  const before=events.length;
  await assert.rejects(protocol.approve({ ...input,intent: { ...intent,generationId: randomUUID(),slot: 'northwind' } }),/INPUT_INVALID/);
  await assert.rejects(protocol.approve({ ...input,response: {} }),/INPUT_INVALID/);
  assert.equal(events.length,before);
  commitFailure=true;await assert.rejects(protocol.approve(input),/ACTUAL_COMMIT_FAILURE/);
  await assert.rejects(protocol.approve({ ...input,intent: { ...intent,operatorId: randomUUID() } }),/INPUT_INVALID/);
});

test('owner failed preparation cannot start or consume a proof and the protocol has no unscoped fallback',async()=>{
  let calls=0;
  const configuration={ withPreparationScope: async()=>{ throw new Error('DEPLOYMENT_STALE'); },
    handoffService: { operationHash() { calls++; },approve() { calls++; } },
    microsoftOperationService: { startStepUp() { calls++; },executeStepUpWithContinuation() { calls++; } } };
  const protocol=createOwnerCustomerAccessProtocol(configuration),input={ principal,intent,correlationId: randomUUID() };
  await assert.rejects(protocol.options(input),/DEPLOYMENT_STALE/);await assert.rejects(protocol.approve(input),/DEPLOYMENT_STALE/);
  assert.equal(calls,0);
  assert.throws(()=>createOwnerCustomerAccessProtocol({ ...configuration,withPreparationScope: null }),/CONFIGURATION/);
});
