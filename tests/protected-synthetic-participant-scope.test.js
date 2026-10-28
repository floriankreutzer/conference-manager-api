import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresProtectedSyntheticParticipantScope } from '../src/persistence/postgres/protected-synthetic-participant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

const epoch='80000000-0000-4000-8000-000000000001',tenant='80000000-0000-4000-8000-000000000002';
const member='80000000-0000-4000-8000-000000000003';
function fixture() {
  const statements=[];let allowed=true;
  const client={ async query(input) {
    statements.push(input);
    return { rowCount: 1,rows: typeof input==='object' && input.name==='protected-synthetic-participant-scope'
      ? [{ allowed }] : [] };
  },release() {} };
  const pool={ query: (...args)=>client.query(...args),connect: async()=>client };
  const leaseClient={ async query(input) {
    const sql=typeof input==='string' ? input : input.text;
    return { rowCount: 1,rows: sql.includes('pg_try_advisory') ? [{ acquired: true }] : [] };
  },release() {} };
  const leasePool={ query: (...args)=>leaseClient.query(...args),connect: async()=>leaseClient };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const port=createPostgresProtectedSyntheticParticipantScope(pool,{ environment: 'int',securityEpoch: epoch });
  return { pool,client,port,scopes,statements,setAllowed(value) { allowed=value; },
    inScope: work=>scopes.withShared(()=>withPostgresTransaction(pool,work)) };
}
test('participant eligibility requires the exact live outer scope and transaction before consulting custody',async()=>{
  const f=fixture();
  await assert.rejects(f.port.allowsWithClient(f.client,tenant,{ membershipId: member }),{ code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' });
  await withPostgresTransaction(f.pool,client=>assert.rejects(f.port.allowsWithClient(client,tenant,{ membershipId: member }),
    { code: 'PROTECTED_SHARED_EXECUTION_REQUIRED' }));
  await f.scopes.withShared(()=>assert.rejects(f.port.allowsWithClient(f.client,tenant,{ membershipId: member }),
    /PARTICIPANT_TRANSACTION_INVALID/));
  assert.equal(f.statements.some(query=>query.name==='protected-synthetic-participant-scope'),false);
});
test('participant reads and admission pass one exact server-derived membership or invitation without granting authority',async()=>{
  const f=fixture();
  await f.inScope(async client=>{
    assert.equal(await f.port.allowsWithClient(client,tenant,{ membershipId: member }),true);
    assert.equal(await f.port.lockAdmissionWithClient(client,tenant,{ invitationId: member }),true);
  });
  const queries=f.statements.filter(query=>query.name==='protected-synthetic-participant-scope');
  assert.deepEqual(queries.map(query=>query.values),[['int',epoch,tenant,member,null,false],['int',epoch,tenant,null,member,true]]);
  assert.equal(queries.every(query=>query.text==='SELECT protected_lock_synthetic_participant_scope($1,$2,$3,$4,$5,$6) AS allowed'),true);
  for (const value of [false,null,undefined,1,'true']) {
    f.setAllowed(value);
    await f.inScope(async client=>assert.equal(await f.port.allowsWithClient(client,tenant,{ membershipId: member }),false));
  }
  assert.deepEqual(Object.keys(f.port).sort(),['allowsWithClient','lockAdmissionWithClient']);
});
test('missing, ambiguous and accessor member context cannot widen tenant-only eligibility or invoke accessors',async()=>{
  const f=fixture();
  await f.inScope(async client=>{
    for (const value of [undefined,null,[],{},member,{ membershipId: member,invitationId: member },
      { membershipId: 'invalid' },{ operatorId: member },{ membershipId: member,role: 'tenant_admin' },
      { get membershipId() { throw new Error('MEMBER_ACCESSOR_EXECUTED'); } },
      Object.defineProperty({},'membershipId',{ value: member,enumerable: false })]) {
      assert.equal(await f.port.allowsWithClient(client,tenant,value),false);
    }
    await assert.rejects(f.port.allowsWithClient({},tenant,{ membershipId: member }),/PARTICIPANT_TRANSACTION_INVALID/);
    await assert.rejects(f.port.allowsWithClient(client,'invalid',{ membershipId: member }),/PARTICIPANT_TRANSACTION_INVALID/);
  });
  assert.equal(f.statements.some(query=>query.name==='protected-synthetic-participant-scope'),false);
});
test('participant scope cannot be constructed in PROD or from malformed deployment custody',()=>{
  const f=fixture();
  for (const environment of ['prod','INT','unknown',null]) assert.throws(()=>
    createPostgresProtectedSyntheticParticipantScope(f.pool,{ environment,securityEpoch: epoch }),/CONFIGURATION_INVALID/);
  assert.throws(()=>createPostgresProtectedSyntheticParticipantScope(f.pool,{ environment: 'int',securityEpoch: 'invalid' }),
    /CONFIGURATION_INVALID/);
});
