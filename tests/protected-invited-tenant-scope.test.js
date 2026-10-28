import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresProtectedInvitedTenantScope } from '../src/persistence/postgres/protected-invited-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

const epoch='80000000-0000-4000-8000-000000000001',tenant='80000000-0000-4000-8000-000000000002';
const member='80000000-0000-4000-8000-000000000003';
function fixture({ enabled=false,real=false }={}) {
  const statements=[];
  const client={ async query(input) {
    statements.push(input);
    if (input?.name==='protected-synthetic-participant-scope') return { rowCount: 1,rows: [{ allowed: true }] };
    return { rowCount: real ? 1 : 0,rows: [] };
  },release() {} };
  const pool={ connect: async()=>client,query: (...args)=>client.query(...args) };
  const leaseClient={ async query(input) {
    const sql=typeof input==='string' ? input : input.text;
    return { rowCount: 1,rows: sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] };
  },release() {} };
  const leasePool={ connect: async()=>leaseClient,query: (...args)=>leaseClient.query(...args) };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const port=createPostgresProtectedInvitedTenantScope(pool,{ environment: 'int',securityEpoch: epoch,
    syntheticParticipantsEnabled: enabled });
  return { pool,port,statements,inScope: work=>scopes.withShared(()=>withPostgresTransaction(pool,work)) };
}
test('invited tenant composition defaults to strict REAL scope and preserves existing REAL admission',async()=>{
  for (const real of [true,false]) {
    const f=fixture({ real });
    await f.inScope(async client=>{
      assert.equal(await f.port.allowsWithClient(client,tenant,{ membershipId: member }),real);
      assert.equal(await f.port.lockAdmissionWithClient(client,tenant,{ membershipId: member }),real);
    });
    assert.equal(f.statements.some(query=>query?.name==='protected-synthetic-participant-scope'),false);
  }
});
test('explicit participant composition still rejects tenant-only access and qualifies each member independently',async()=>{
  const f=fixture({ enabled: true });
  await f.inScope(async client=>{
    assert.equal(await f.port.allowsWithClient(client,tenant),false);
    assert.equal(await f.port.lockAdmissionWithClient(client,tenant,{}),false);
    assert.equal(await f.port.allowsWithClient(client,tenant,{ membershipId: member }),true);
    assert.equal(await f.port.lockAdmissionWithClient(client,tenant,{ invitationId: member }),true);
  });
  const calls=f.statements.filter(query=>query?.name==='protected-synthetic-participant-scope');
  assert.deepEqual(calls.map(query=>query.values),[
    ['int',epoch,tenant,member,null,false],['int',epoch,tenant,null,member,true],
  ]);
  const real=fixture({ enabled: true,real: true });
  await real.inScope(async client=>assert.equal(await real.port.allowsWithClient(client,tenant),true));
  assert.equal(real.statements.some(query=>query?.name==='protected-synthetic-participant-scope'),false);
});
test('participant enablement is a strict boolean and cannot select PROD',()=>{
  const f=fixture();
  for (const syntheticParticipantsEnabled of [null,'true',1]) assert.throws(()=>
    createPostgresProtectedInvitedTenantScope(f.pool,{ environment: 'int',securityEpoch: epoch,syntheticParticipantsEnabled }),
    /CONFIGURATION_INVALID/);
  assert.throws(()=>createPostgresProtectedInvitedTenantScope(f.pool,{ environment: 'prod',securityEpoch: epoch,
    syntheticParticipantsEnabled: true }),/CONFIGURATION_INVALID/);
});
