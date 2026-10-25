import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedCustomerSessionService } from '../src/identity/protected-customer-session-service.js';

const TENANT='c2000000-0000-4000-8000-000000000001',USER='c2000000-0000-4000-8000-000000000002';
const SESSION='c2000000-0000-4000-8000-000000000003',EPOCH='c2000000-0000-4000-8000-000000000004';
const principal={ tenantId: TENANT,userId: USER,providerIdentity: { provider: 'email_code',reference: USER },roles: ['employee'],
  permissions: [],session: { id: SESSION,securityVersion: 1,issuedAt: '2026-10-20T12:00:00.000Z',
    expiresAt: '2026-10-20T13:00:00.000Z' } };
const real={ environment: 'int',tenantId: TENANT,securityEpoch: EPOCH,mode: 'real',
  generationId: null,generationState: null,operatorId: null,slot: null };
const synthetic={ ...real,mode: 'synthetic',generationId: SESSION,generationState: 'active',operatorId: USER,slot: 'northwind' };

function fixture({ identity=principal,access={ kind: 'invited_membership',runtime: real } }={}) {
  const calls=[];
  const base={ resolvePrincipal: async()=>identity };
  for (const method of ['issue','rotate','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie']) {
    base[method]=(...args)=>({ method,args });
  }
  const service=createProtectedCustomerSessionService({ sessionService: base,environment: 'int',securityEpoch: EPOCH,accessRepository: {
    async resolveCurrentAccess(value) { calls.push(value);return typeof access==='function' ? access() : access; },
  } });
  return { service,calls,base };
}

test('ordinary session is necessary and current custody is re-read on every protected request',async()=>{
  const { service,calls }=fixture();assert.deepEqual(await service.resolvePrincipal({}),principal);
  assert.deepEqual(await service.resolvePrincipal({}),principal);assert.equal(calls.length,2);
  assert.deepEqual(calls[0],{ environment: 'int',securityEpoch: EPOCH,principal });
  const missing=fixture({ identity: null });assert.equal(await missing.service.resolvePrincipal({}),null);
  assert.equal(missing.calls.length,0);
});

test('only invited real identity or live operator delegation can cross its own classified boundary',async()=>{
  for (const provider of ['email_code','microsoft_entra']) {
    const identity={ ...principal,providerIdentity: { provider,reference: USER } };
    assert.ok(await fixture({ identity }).service.resolvePrincipal({}));
    assert.equal(await fixture({ identity,access: { kind: 'operator_delegation',runtime: synthetic } }).service.resolvePrincipal({}),null);
  }
  const delegated={ ...principal,providerIdentity: { provider: 'platform_delegation',reference: USER } };
  assert.ok(await fixture({ identity: delegated,access: { kind: 'operator_delegation',runtime: synthetic } }).service.resolvePrincipal({}));
  assert.equal(await fixture({ identity: delegated }).service.resolvePrincipal({}),null);
  for (const provider of ['demo','test_identity','legacy_persona']) {
    assert.equal(await fixture({ identity: { ...principal,providerIdentity: { provider,reference: USER } } })
      .service.resolvePrincipal({}),null);
  }
});

test('unknown, foreign, revoked/stale custody and archived generations never inherit ordinary session authority',async()=>{
  for (const access of [null,undefined,false,[],{},real,{ runtime: real,kind: 'accepted' },
    { runtime: { ...real,environment: 'dev' },kind: 'invited_membership' },
    { runtime: { ...real,tenantId: USER },kind: 'invited_membership' },
    { runtime: { ...real,securityEpoch: SESSION },kind: 'invited_membership' },
    { runtime: real,kind: 'invited_membership',accepted: true },
    { runtime: { ...synthetic,generationState: 'archived' },kind: 'operator_delegation' }]) {
    assert.equal(await fixture({ access: ()=>access }).service.resolvePrincipal({}),null);
  }
  const denied=fixture({ access: ()=>{ throw new Error('CUSTODY_UNAVAILABLE'); } });
  await assert.rejects(denied.service.resolvePrincipal({}),/CUSTODY_UNAVAILABLE/);
});

test('session issuance, CSRF, rotation and audited revocation retain their existing private service contracts',()=>{
  const { service,base }=fixture();
  for (const method of ['issue','rotate','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie']) {
    assert.equal(service[method],base[method]);assert.deepEqual(service[method]('synthetic-input'),base[method]('synthetic-input'));
  }
});

test('protected session composition requires explicit deployment epoch and complete authoritative ports',()=>{
  const { base }=fixture(),accessRepository={ resolveCurrentAccess: async()=>null };
  const options={ sessionService: base,accessRepository,environment: 'int',securityEpoch: EPOCH };
  for (const change of [{ environment: 'demo' },{ environment: undefined },{ securityEpoch: undefined },
    { securityEpoch: 'legacy' },{ accessRepository: {} },{ sessionService: null }]) {
    assert.throws(()=>createProtectedCustomerSessionService({ ...options,...change }),/PROTECTED_CUSTOMER_SESSION_CONFIGURATION_INVALID/);
  }
  for (const method of ['resolvePrincipal','issue','rotate','revoke','verifyCsrf','csrfTokenForPrincipal','clearCookie']) {
    assert.throws(()=>createProtectedCustomerSessionService({ ...options,sessionService: { ...base,[method]: undefined } }),
      /PROTECTED_CUSTOMER_SESSION_CONFIGURATION_INVALID/);
  }
});


test('REAL own-owner custody is an exact kind/provider pair and can never inherit invited or synthetic authority',async()=>{
  const identity={ ...principal,providerIdentity: { provider: 'platform_owner',reference: USER } };
  assert.ok(await fixture({ identity,access: { kind: 'owner_delegation',runtime: real } }).service.resolvePrincipal({}));
  for (const access of [{ kind: 'invited_membership',runtime: real },{ kind: 'operator_delegation',runtime: synthetic },
    { kind: 'owner_delegation',runtime: synthetic },{ kind: 'owner_delegation',runtime: { ...real,tenantId: USER } },
    { kind: 'owner_delegation',runtime: { ...real,securityEpoch: SESSION } }]) {
    assert.equal(await fixture({ identity,access }).service.resolvePrincipal({}),null);
  }
  for (const provider of ['email_code','microsoft_entra','platform_delegation','demo','test_identity']) {
    const other={ ...principal,providerIdentity: { provider,reference: USER } };
    assert.equal(await fixture({ identity: other,access: { kind: 'owner_delegation',runtime: real } })
      .service.resolvePrincipal({}),null);
  }
});
