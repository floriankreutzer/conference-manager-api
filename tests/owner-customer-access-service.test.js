import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOwnerCustomerAccessService } from '../src/platform/application/owner-customer-access-service.js';
import { createOwnerCustomerHandoffBrowserBinding } from '../src/identity/owner-customer-handoff-browser-binding.js';
import { PLATFORM_ROLE,permissionsForPlatformRoles,createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';

const now=Date.parse('2026-10-24T12:00:00.000Z'),instant=value=>new Date(value).toISOString();
const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://app.example.test',platformOrigin: 'https://ops.example.test' };
const roles=Object.values(PLATFORM_ROLE).sort(),operatorId=randomUUID(),flowId=randomUUID();
const normal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 6,
  providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: randomUUID(),subjectReference: randomUUID() },
  targetScope: { mode: 'all',securityVersion: 6 },
  assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: instant(now) },
  session: { id: randomUUID(),issuedAt: instant(now),expiresAt: instant(now+3_600_000),securityVersion: 6,
    securityEpoch: 7,stepUpExpiresAt: null } };
const fresh={ ...normal,assurance: { ...normal.assurance,level: 'step_up',authenticationContext: 'cm:ms:fresh:v1' },
  session: { ...normal.session,id: randomUUID(),stepUpExpiresAt: instant(now+300_000) } };

// Service-port tests only. No fixture result stands for designated-owner SQL
// custody, actual provider verification, native commit or deployed acceptance.
function fixture() {
  const browserBinding=createOwnerCustomerHandoffBrowserBinding({ scope,secret: 's'.repeat(48) });
  const start=browserBinding.issueStart(flowId),intent={ flowId,state: start.state,operatorId,tenantId: randomUUID(),role: 'tenant_admin' };
  const binding={ flowId,stateHash: start.stateHash,browserVerifier: start.browserVerifier };
  const proofContext=Object.freeze({}),calls={ prepared: 0,verified: 0,approved: 0 };
  let available=true,proof={ principal: fresh,continuationPrincipal: normal },expectedHash,result;
  const service=createOwnerCustomerAccessService({ scope,browserBinding,
    authorizationPolicy: createPlatformAuthorizationPolicy({ clock: ()=>now }),
    microsoftOperationService: { verifiedOperationWithContinuation(context,hash) {
      assert.equal(context,proofContext);assert.equal(hash,expectedHash);calls.verified++;return proof;
    } },repository: {
      async prepare(input) { calls.prepared++;assert.equal(input.principal.operatorId,operatorId);
        assert.equal(input.stateHash,start.stateHash);return available ? binding : null; },
      async binding() { return available ? binding : null; },
      async approve(input) { calls.approved++;assert.equal(input.operationHash,expectedHash);
        assert.deepEqual(input.continuationPrincipal,normal);assert.deepEqual(input.expectedBinding,binding);
        return result ?? { status: 'approved',code: browserBinding.issueCode(flowId).code,expiresAt: instant(now+60_000) }; },
    } });
  return { service,intent,proofContext,calls,browserBinding,async prepare() {
    expectedHash=await service.operationHash({ principal: normal,intent });return expectedHash;
  },available: value=>{ available=value; },proof: value=>{ proof=value; },result: value=>{ result=value; } };
}

test('owner service binds exact REAL selection and forwards only a fixed private redirect after qualified ports succeed',async()=>{
  const f=fixture();await f.prepare();
  const result=await f.service.approve({ proofContext: f.proofContext,intent: f.intent,correlationId: randomUUID() });
  const location=new URL(result.location);assert.equal(result.status,'redirect');
  assert.equal(location.origin,scope.customerOrigin);assert.equal(location.pathname,'/api/v1/auth/owner/callback');
  assert.equal(location.searchParams.get('state'),f.intent.state);
  assert.deepEqual([...location.searchParams.keys()],['state','code']);
  assert.deepEqual(f.calls,{ prepared: 1,verified: 1,approved: 1 });f.browserBinding.destroy();
});

test('missing current custody, forged context, downgraded continuation and expired fresh authority cannot approve',async()=>{
  for (const failure of ['custody','context','provider','scope','expired']) {
    const f=fixture();await f.prepare();let context=f.proofContext;
    if (failure==='custody') f.available(false);
    if (failure==='context') context=Object.freeze({});
    if (failure==='provider') f.proof({ principal: fresh,continuationPrincipal: { ...normal,
      providerIdentity: { ...normal.providerIdentity,subjectReference: randomUUID() } } });
    if (failure==='scope') f.proof({ principal: fresh,continuationPrincipal: { ...normal,
      targetScope: { mode: 'allowlist',securityVersion: 6 } } });
    if (failure==='expired') f.proof({ principal: { ...fresh,
      assurance: { ...fresh.assurance,authenticatedAt: instant(now-1000) },
      session: { ...fresh.session,issuedAt: instant(now-1000),stepUpExpiresAt: instant(now) } },
    continuationPrincipal: { ...normal,assurance: { ...normal.assurance,authenticatedAt: instant(now-1000) } } });
    await assert.rejects(f.service.approve({ proofContext: context,intent: f.intent,correlationId: randomUUID() }));
    assert.equal(f.calls.approved,0);f.browserBinding.destroy();
  }
});

test('owner service rejects extra browser authority and malformed private approval results',async()=>{
  const f=fixture();await f.prepare();
  await assert.rejects(f.service.operationHash({ principal: normal,intent: { ...f.intent,userId: randomUUID() } }),/INPUT_INVALID/);
  assert.equal(f.calls.prepared,1);
  for (const result of [{ status: 'approved',code: 'unbounded',expiresAt: instant(now+60_000) },
    { status: 'approved',code: Buffer.alloc(32,1).toString('base64url'),expiresAt: 'tomorrow' },
    { status: 'approved',code: Buffer.alloc(32,1).toString('base64url'),expiresAt: instant(now+60_000),userId: randomUUID() }]) {
    f.result(result);await assert.rejects(f.service.approve({ proofContext: f.proofContext,intent: f.intent,correlationId: randomUUID() }));
  }
  f.browserBinding.destroy();
});
