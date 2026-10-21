import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createProtectedTenantProviderGate } from '../src/tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError } from '../src/tenancy/protected-tenant-runtime.js';

const scope={ environment: 'int',securityEpoch: '80000000-0000-4000-8000-000000000001' };
const tenantId='80000000-0000-4000-8000-000000000002';
function fixture() {
  const queries=[];let busy=false,mode='real',failure=null;
  const client={ async query(input) {
    queries.push(input);if (failure && input?.name==='protected-tenant-current-runtime') throw failure;
    return { rowCount: 1,rows: input?.name==='protected-tenant-current-runtime'
      ? [{ mode,generation_id: null,generation_state: null,operator_id: null,slot: null }] : [] };
  },release() { busy=false; } };
  const pool={ query: input=>{
    assert.equal(busy,false,'callback must not retain the business read connection');return client.query(input);
  },
    async connect() { assert.equal(busy,false,'max1 business connection cannot be reacquired');busy=true;return client; } };
  const leaseQueries=[];let leased=false;
  const leasePool={ query() { assert.fail('NO_DIRECT_LEASE_READ'); },async connect() {
    assert.equal(leased,false,'exact shared scope must join');leased=true;
    return { async query(input) { leaseQueries.push(input);return { rowCount: 1,rows: [{ acquired: true }] }; },
      release() { leased=false; } };
  } };
  const repository=createPostgresProtectedTenantRuntimeRepository(pool,{ ...scope,leasePool });
  return { pool,leasePool,repository,queries,leaseQueries,setMode(value) { mode=value; },setFailure(value) { failure=value; } };
}

test('owned provider lookup releases its short business read while retaining and joining the exact live lease',async()=>{
  const f=fixture(),scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: f.pool,leasePool: f.leasePool,...scope });
  const gate=createProtectedTenantProviderGate({ repository: f.repository,...scope,mode: 'real' });
  await scopes.withShared(()=>gate.run(tenantId,async runtime=>{
    assert.equal(runtime.mode,'real');assert.notEqual(f.leaseQueries.at(-1),'COMMIT');
    await f.pool.query('SELECT provider_work');assert.equal((await f.repository.findCurrent(tenantId)).mode,'real');
    await withPostgresTransaction(f.pool,async client=>{
      assert.equal((await f.repository.findCurrent(tenantId)).mode,'real');await client.query('SELECT transactional_provider_work');
    },{ isolationLevel: 'REPEATABLE READ' });
  }));
  assert.equal(f.queries.filter(q=>q==='BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY').length,2);
  assert.equal(f.queries.filter(q=>q==='BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE').length,1);
  assert.equal(f.leaseQueries.filter(q=>q==='COMMIT').length,1);
});

test('wrong mode, lookup failure, callback failure and malformed explicit lease configuration never grant or fall back',async()=>{
  const f=fixture(),gate=createProtectedTenantProviderGate({ repository: f.repository,...scope,mode: 'synthetic' });
  await assert.rejects(gate.run(tenantId,()=>assert.fail('REAL_OUTBOUND')),ProtectedTenantRuntimeError);
  const failure=new Error('LOOKUP_FAILED');f.setFailure(failure);
  await assert.rejects(f.repository.withCurrentTenantRuntime({ ...scope,tenantId },()=>assert.fail('LOOKUP_FALLBACK')),
    error=>error===failure);
  assert.equal(f.leaseQueries.at(-1),'ROLLBACK');f.setFailure(null);
  await assert.rejects(f.repository.withCurrentTenantRuntime({ ...scope,tenantId },()=>{ throw new Error('PROVIDER_FAILED'); }),
    /PROVIDER_FAILED/);assert.equal(f.leaseQueries.at(-1),'ROLLBACK');
  for (const leasePool of [{},f.pool]) {
    assert.throws(()=>createPostgresProtectedTenantRuntimeRepository(f.pool,{ ...scope,leasePool }),/CONFIGURATION_INVALID/);
  }
});


test('explicit cleanup lookup preserves the same max1 lease while binding a separate REAL-only inactive predicate',async()=>{
  const f=fixture();await f.repository.findCurrent(tenantId);
  assert.equal(f.queries.find(q=>q?.name==='protected-tenant-current-runtime').values.at(-1),false);
  await f.repository.withCurrentTenantCleanupRuntime({ ...scope,tenantId },async value=>{
    assert.equal(value.mode,'real');await f.pool.query('SELECT actual_cleanup_work');
  });
  const lookups=f.queries.filter(q=>q?.name==='protected-tenant-current-runtime');
  assert.equal(lookups.at(-1).values.at(-1),true);
  assert.match(lookups.at(-1).text,/registry.mode='real' AND tenant.status IN \('suspended','archived'\)/);
  const leases=f.leaseQueries.length;
  assert.throws(()=>f.repository.withCurrentTenantCleanupRuntime({ ...scope,securityEpoch: tenantId,tenantId },()=>{}),
    /PROTECTED_TENANT_RUNTIME_SCOPE_INVALID/);assert.equal(f.leaseQueries.length,leases);
});
