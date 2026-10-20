import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSessionService } from '../src/identity/session-service.js';
import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';
import { createProtectedCustomerSessionNamespace } from '../src/identity/protected-customer-session-namespace.js';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT='d1000000-0000-4000-8000-000000000001',USER='d1000000-0000-4000-8000-000000000002';
const EPOCH='d1000000-0000-4000-8000-000000000003',NEXT='d1000000-0000-4000-8000-000000000004';
const NOW=Date.parse('2026-10-20T15:00:00.000Z');
const identity={ tenantId: TENANT,userId: USER,securityVersion: 1,...tenantAuthorizationSnapshot(['employee']),
  providerIdentity: { provider: 'email_code',reference: USER } };

function fixture() {
  const stored=new Map(),reads=[];
  const repository={ matchesProtectionScope: ()=>true,async issue(record) {
    const value={ ...record,securityVersion: record.expectedSecurityVersion };stored.set(record.tokenHash,value);return value;
  },async resolveByTokenHash(hash) { const value=stored.get(hash);return value?.revoked ? null : value ?? null; },
  async revoke({ sessionId }) { const value=[...stored.values()].find(row=>row.id===sessionId);value.revoked=true;return true; },
  async rotate({ currentSessionId,session }) {
    const old=[...stored.values()].find(row=>row.id===currentSessionId);if (!old || old.revoked) return null;
    old.revoked=true;return repository.issue(session);
  } };
  const base={ sessionRepository: repository,auditService: createAuditHarness({ clock: ()=>NOW }).service,
    publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48),clock: ()=>NOW,idFactory: randomUUID };
  const accessRepository={ async resolveCurrentAccess({ environment,securityEpoch,principal }) {
    reads.push({ environment,securityEpoch,principal });return { kind: 'invited_membership',runtime: {
      environment,securityEpoch,tenantId: principal.tenantId,mode: 'real',
      generationId: null,generationState: null,operatorId: null,slot: null,
    } };
  } };
  const create=(environment,securityEpoch,token)=>{
    const tokens=[token,'E'.repeat(43)];
    return createProtectedInvitedCustomerSessions({ ...base,environment,securityEpoch,accessRepository,tokenFactory: ()=>tokens.shift() });
  };
  const legacy=createSessionService({ ...base,repository,tokenFactory: ()=> 'A'.repeat(43) });
  return { create,legacy,stored,reads,base };
}
const request=result=>({ headers: { cookie: result.setCookie.split(';')[0] } });

test('legacy, deployment and protected epoch namespaces cannot resolve each others cookies in the same repository',async()=>{
  const f=fixture(),int=f.create('int',EPOCH,'B'.repeat(43)),dev=f.create('dev',EPOCH,'C'.repeat(43));
  const old=await f.legacy.issue(identity,{ correlationId: randomUUID() });
  const current=await int.issue(identity,{ correlationId: randomUUID() });
  assert.equal(await int.resolvePrincipal(request(old)),null);assert.equal(await f.legacy.resolvePrincipal(request(current)),null);
  assert.equal(await dev.resolvePrincipal(request(current)),null);
  assert.equal(await f.create('int',NEXT,'D'.repeat(43)).resolvePrincipal(request(current)),null);
  const principal=await int.resolvePrincipal(request(current));assert.equal(principal.userId,USER);assert.equal(f.reads.length,1);
  const expected=createHash('sha256').update(`customer-session:saas-3.6-role-policy-v1:protected-v1:int:${EPOCH}:${'B'.repeat(43)}`)
    .digest('hex');assert.ok(f.stored.has(expected));
  assert.ok(f.stored.has(createHash('sha256').update(`customer-session:saas-3.6-role-policy-v1:${'A'.repeat(43)}`).digest('hex')));
  assert.equal(await int.verifyCsrf({ headers: { 'x-csrf-token': current.csrfToken } },principal),true);
  const rotated=await int.rotate(principal,{ ...identity,securityVersion: 2 },{ correlationId: randomUUID() });
  assert.equal(await int.resolvePrincipal(request(current)),null);
  const next=await int.resolvePrincipal(request(rotated));assert.equal(next.session.securityVersion,2);
  assert.ok(f.stored.has(createHash('sha256')
    .update(`customer-session:saas-3.6-role-policy-v1:protected-v1:int:${EPOCH}:${'E'.repeat(43)}`).digest('hex')));
  await int.revoke(next,{ correlationId: randomUUID() });assert.equal(await int.resolvePrincipal(request(rotated)),null);
});

test('namespace construction is server-only, canonical and closed; arbitrary prefixes and Demo issuers are denied',async()=>{
  assert.equal(createProtectedCustomerSessionNamespace({ environment: 'int',securityEpoch: EPOCH.toUpperCase() }),
    `protected-v1:int:${EPOCH}`);
  for (const environment of ['demo','test','INT',null,undefined]) {
    assert.throws(()=>createProtectedCustomerSessionNamespace({ environment,securityEpoch: EPOCH }),/NAMESPACE_INVALID/);
  }
  for (const securityEpoch of [null,undefined,'legacy','00000000-0000-0000-0000-000000000000']) {
    assert.throws(()=>createProtectedCustomerSessionNamespace({ environment: 'int',securityEpoch }),/NAMESPACE_INVALID/);
  }
  const f=fixture();
  for (const matchesProtectionScope of [undefined,()=>false,()=> 'true']) {
    assert.throws(()=>createProtectedInvitedCustomerSessions({ ...f.base,environment: 'int',securityEpoch: EPOCH,
      sessionRepository: { ...f.base.sessionRepository,matchesProtectionScope } }),/PROTECTED_CUSTOMER_SESSION_REPOSITORY_REQUIRED/);
  }
  for (const securityNamespace of [null,'demo','protected-v1:int:legacy',`protected-v1:demo:${EPOCH}`]) {
    assert.throws(()=>createSessionService({ ...f.base,repository: f.base.sessionRepository,securityNamespace }),/NAMESPACE_INVALID/);
  }
  const service=f.create('int',EPOCH,'B'.repeat(43));
  for (const provider of ['demo_customer','platform_delegation','test_identity']) {
    await assert.rejects(async()=>service.issue({ ...identity,providerIdentity: { provider,reference: USER } },
      { correlationId: randomUUID() }),/PROTECTED_CUSTOMER_SESSION_PROVIDER_DENIED/);
  }
  assert.equal(f.stored.size,0);
});
