import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPostgresProtectedRuntimeExecutionScopes,requireProtectedSyntheticExecutionScope,
} from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { AsyncResource } from 'node:async_hooks';
import { withProtectedRuntimeRepeatableExclusiveGate } from '../src/persistence/postgres/protected-runtime-gate.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

const epoch='80000000-0000-4000-8000-000000000001',operatorId='80000000-0000-4000-8000-000000000002';
const owner={ operatorId,operatorSecurityVersion: 3 };
function pool() {
  const queries=[];let rowCount=1;
  const client={ async query(input) {
    queries.push(input);const text=typeof input==='string' ? input : input.text;
    return { rowCount,rows: text.includes('pg_try_advisory') ? [{ acquired: true }] : [] };
  },release() {} };
  return { queries,client,setRowCount(value) { rowCount=value; },
    port: { query: (...args)=>client.query(...args),connect: async()=>client } };
}

test('shared scope uses its own pool; business RR snapshot and reads do not join the RC lease transaction',async()=>{
  const business=pool(),lease=pool();
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: lease.port,
    environment: 'int',securityEpoch: epoch });
  await scopes.withShared(async()=>{
    await business.port.query('SELECT 1');
    await withPostgresTransaction(business.port,async client=>assert.equal(client,business.client),
      { isolationLevel: 'REPEATABLE READ' });
  });
  assert.equal(lease.queries[0],'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE');
  assert.ok(business.queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE'));
  assert.equal(lease.queries.at(-1),'COMMIT');
  await assert.rejects(withPostgresTransaction(business.port,()=>scopes.withShared(async()=>null)),
    { code: 'PROTECTED_RUNTIME_GATE_ORDER_INVALID' });
});

test('synthetic exclusive scope revalidates epoch and stamps current actual owner before work in one RR client',async()=>{
  const business=pool(),lease=pool();
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: lease.port,
    environment: 'int',securityEpoch: epoch });
  await scopes.withSyntheticExclusive(owner,async client=>{
    assert.equal(client,business.client);
    const statements=business.queries.filter(query=>typeof query==='object');
    assert.ok(statements[1].text.endsWith('FOR UPDATE'));
    assert.ok(statements[2].text.startsWith('UPDATE platform_operators SET updated_at='));
    assert.deepEqual(statements[2].values,[operatorId,3,PLATFORM_ENTRA_PROVIDER]);
    assert.equal(await withPostgresTransaction(business.port,async same=>same===client,{ isolationLevel: 'REPEATABLE READ' }),true);
  });
  assert.equal(business.queries[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
  business.setRowCount(0);let calls=0;
  await assert.rejects(scopes.withSyntheticExclusive(owner,async()=>{ calls++; }),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  assert.equal(calls,0);assert.equal(business.queries.at(-1),'ROLLBACK');
  lease.setRowCount(0);
  await assert.rejects(scopes.withShared(async()=>{ calls++; }),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  assert.equal(calls,0);
});

test('scope configuration rejects aliased pools, production reset, malformed owner and cross-mode upgrades',async()=>{
  const business=pool(),lease=pool();
  assert.throws(()=>createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: business.port,
    environment: 'int',securityEpoch: epoch }),/CONFIGURATION_INVALID/);
  const prod=createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: lease.port,
    environment: 'prod',securityEpoch: epoch });
  assert.throws(()=>prod.withSyntheticExclusive(owner,async()=>null),/SCOPE_INVALID/);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: lease.port,
    environment: 'int',securityEpoch: epoch });
  for (const scope of [null,{ ...owner,tenantId: operatorId },{ ...owner,operatorSecurityVersion: 0 }]) {
    assert.throws(()=>scopes.withSyntheticExclusive(scope,async()=>null),/SCOPE_INVALID/);
  }
  await scopes.withShared(()=>assert.rejects(scopes.withSyntheticExclusive(owner,async()=>assert.fail('UPGRADE')),
    { code: 'PROTECTED_RUNTIME_GATE_SCOPE_INVALID' }));
});

test('synthetic custody requires the exact live owner-stamped scope, not an arbitrary RR transaction or lease',async()=>{
  const business=pool(),lease=pool(),scope={ ...owner,environment: 'int',securityEpoch: epoch };
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: business.port,leasePool: lease.port,...scope });
  const denied=()=>assert.throws(()=>requireProtectedSyntheticExecutionScope(business.port,business.client,scope),
    { code: 'PROTECTED_SYNTHETIC_EXECUTION_REQUIRED' });
  denied();
  await withPostgresTransaction(business.port,async()=>denied(),{ isolationLevel: 'REPEATABLE READ' });
  await withProtectedRuntimeRepeatableExclusiveGate(business.port,'int',async()=>denied());
  await scopes.withShared(async()=>denied());
  let detached;
  await scopes.withSyntheticExclusive(owner,async client=>{
    assert.equal(requireProtectedSyntheticExecutionScope(business.port,client,scope),true);
    for (const candidate of [{ ...scope,environment: 'dev' },{ ...scope,securityEpoch: operatorId },
      { ...scope,operatorId: epoch },{ ...scope,operatorSecurityVersion: 4 },{ ...scope,extra: true }]) {
      assert.throws(()=>requireProtectedSyntheticExecutionScope(business.port,client,candidate),
        { code: 'PROTECTED_SYNTHETIC_EXECUTION_REQUIRED' });
    }
    assert.throws(()=>requireProtectedSyntheticExecutionScope(lease.port,client,scope),
      { code: 'PROTECTED_SYNTHETIC_EXECUTION_REQUIRED' });
    assert.throws(()=>requireProtectedSyntheticExecutionScope(business.port,lease.client,scope),
      { code: 'PROTECTED_SYNTHETIC_EXECUTION_REQUIRED' });
    detached=AsyncResource.bind(denied);
  });
  detached();denied();
});
