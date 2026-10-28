import assert from 'node:assert/strict';
import test from 'node:test';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresProtectedCustomerAccessRepository,createPostgresProtectedParticipantCustomerAccessRepository }
  from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

const epoch='81000000-0000-4000-8000-000000000001',tenant='81000000-0000-4000-8000-000000000002';
const user='81000000-0000-4000-8000-000000000003',member='81000000-0000-4000-8000-000000000004';
const generation='81000000-0000-4000-8000-000000000005',operator='81000000-0000-4000-8000-000000000006';
const principal={ tenantId: tenant,userId: user,providerIdentity: { provider: 'email_code',reference: member },
  ...tenantAuthorizationSnapshot(['employee']),session: { id: member,securityVersion: 1,
    issuedAt: '2026-10-27T12:00:00.000Z',expiresAt: '2026-10-27T13:00:00.000Z' } };
function fixture() {
  const calls=[],state={ member: true,allowed: true,session: true,roles: [],mode: 'synthetic',real: false };
  const client={ async query(input) {
    calls.push(input);
    if (input.name==='protected-delivery-real-tenant-lock') return { rowCount: state.real ? 1 : 0,rows: [] };
    if (input.name==='protected-participant-principal-member') {
      assert.deepEqual(input.values,['int',tenant,user]);
      return { rowCount: state.member ? 1 : 0,rows: state.member ? [{ id: member }] : [] };
    }
    if (input.name==='protected-synthetic-participant-scope') {
      assert.deepEqual(input.values,['int',epoch,tenant,member,null,false]);
      return { rowCount: 1,rows: [{ allowed: state.allowed }] };
    }
    if (input.name==='protected-customer-current-invited-access') {
      assert.equal(input.values[12],true);
      return { rowCount: state.session ? 1 : 0,rows: state.session ? [{ roles: state.roles,mode: state.mode,
        generation_id: generation,operator_id: operator,slot: 'northwind' }] : [] };
    }
    return { rowCount: 0,rows: [] };
  },release() {} };
  const pool={ connect: async()=>client,query: async()=>{ throw new Error('READ_ESCAPED_OWNED_TRANSACTION'); } };
  const leaseClient={ async query(input) {
    const sql=typeof input==='string' ? input : input.text;
    return { rowCount: 1,rows: sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] };
  },release() {} };
  const leasePool={ connect: async()=>leaseClient,query: (...args)=>leaseClient.query(...args) };
  const protection={ environment: 'int',securityEpoch: epoch };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...protection });
  const access=createPostgresProtectedParticipantCustomerAccessRepository(pool,protection);
  const resolve=value=>scopes.withShared(()=>access.resolveCurrentAccess({ ...protection,principal: value ?? principal }));
  return { pool,client,protection,scopes,access,calls,state,resolve };
}
test('participant access locks the exact current member before re-reading complete identity/session/roles',async()=>{
  const f=fixture();
  for (const provider of ['email_code','microsoft_entra']) {
    const value=await f.resolve({ ...principal,providerIdentity: { provider,reference: member } });
    assert.equal(value.kind,'synthetic_participant');assert.equal(value.runtime.generationId,generation);
    assert.equal(value.runtime.operatorId,operator);assert.equal(value.runtime.slot,'northwind');
  }
  const names=f.calls.map(value=>value.name);
  assert.ok(names.indexOf('protected-synthetic-participant-scope')<names.indexOf('protected-customer-current-invited-access'));
  assert.equal(f.calls.at(-1),'COMMIT');
});
test('missing member, stale generation, missing session or changed current authorization fail closed',async()=>{
  for (const change of [{ member: false },{ allowed: false },{ session: false },{ roles: ['tenant_admin'] },{ mode: 'unknown' }]) {
    const f=fixture();Object.assign(f.state,change);assert.equal(await f.resolve(),null);
    if (change.member===false || change.allowed===false) {
      assert.equal(f.calls.some(value=>value.name==='protected-customer-current-invited-access'),false);
    }
  }
  for (const provider of ['platform_delegation','platform_owner','test_identity','demo_customer']) {
    const f=fixture();assert.equal(await f.resolve({ ...principal,providerIdentity: { provider,reference: member } }),null);
    assert.equal(f.calls.some(value=>value.name==='protected-synthetic-participant-scope'),false);
  }
});
test('participant access requires the live lease, joins its single current transaction and preserves REAL custody',async()=>{
  const f=fixture();
  await assert.rejects(f.access.resolveCurrentAccess({ ...f.protection,principal }),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  await f.scopes.withShared(()=>withPostgresTransaction(f.pool,async client=>{
    assert.equal(client,f.client);
    assert.equal((await f.access.resolveCurrentAccessWithClient(client,{ ...f.protection,principal })).kind,'synthetic_participant');
  }));
  f.state.real=true;f.state.mode='real';
  const value=await f.resolve();assert.equal(value.kind,'invited_membership');assert.equal(value.runtime.generationId,null);
});
test('fixed REAL construction cannot enable participants and separate participant construction rejects Production',async()=>{
  const f=fixture(),queries=[];
  const fixed=createPostgresProtectedCustomerAccessRepository({ query: async input=>{
    queries.push(input);return { rowCount: 0,rows: [] };
  } },{ ...f.protection,syntheticParticipantsEnabled: true });
  assert.equal(await fixed.resolveCurrentAccess({ ...f.protection,principal }),null);
  assert.equal(queries[0].values[12],false);
  for (const environment of ['prod','INT',null]) assert.throws(()=>
    createPostgresProtectedParticipantCustomerAccessRepository(f.pool,{ ...f.protection,environment }),/CONFIGURATION_INVALID/);
});
