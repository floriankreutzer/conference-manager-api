import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';
import { createProtectedTenantProviderGate } from '../src/tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError } from '../src/tenancy/protected-tenant-runtime.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }

test('native max1 provider custody releases business reads, joins the request lease and fences reset for the whole callback',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const scope={ environment: 'int',securityEpoch: randomUUID() },tenantId=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[scope.securityEpoch]);
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic local provider fixture','active')",[tenantId]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[tenantId]);
  const repository=createPostgresProtectedTenantRuntimeRepository(pool,{ ...scope,leasePool });
  const requestScopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,...scope });
  const gate=createProtectedTenantProviderGate({ repository,...scope,mode: 'real' });
  const synthetic=createProtectedTenantProviderGate({ repository,...scope,mode: 'synthetic' });
  await assert.rejects(synthetic.run(tenantId,()=>assert.fail('MODE_FALLBACK')),ProtectedTenantRuntimeError);
  await assert.rejects(gate.run(randomUUID(),()=>assert.fail('UNKNOWN_OUTBOUND')),ProtectedTenantRuntimeError);
  const entered=deferred(),release=deferred();let calls=0;
  const pending=requestScopes.withShared(()=>gate.run(tenantId,async runtime=>{
    calls++;assert.equal(runtime.mode,'real');assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1);
    await withPostgresTransaction(pool,async client=>{
      assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');
      assert.equal((await repository.findCurrent(tenantId)).tenantId,tenantId);
    },{ isolationLevel: 'REPEATABLE READ' });
    entered.resolve();await release.promise;
    assert.equal((await repository.findCurrent(tenantId)).mode,'real');return 'provider-completed';
  }));
  await Promise.race([entered.promise,pending.then(()=>{ throw new Error('PROVIDER_CALLBACK_NOT_ENTERED'); })]);
  try {
    await assert.rejects(control.query("SELECT protected_runtime_acquire_exclusive('int')"),/PROTECTED_RUNTIME_BUSY/);
  } finally { release.resolve(); }
  assert.equal(await pending,'provider-completed');assert.equal(calls,1);
  await control.query("SELECT protected_runtime_acquire_exclusive('int')");
  await assert.rejects(gate.run(tenantId,()=>{ throw new Error('PROVIDER_FAILURE'); }),/PROVIDER_FAILURE/);
  await control.query("SELECT protected_runtime_acquire_exclusive('int')");
  const stale=createPostgresProtectedTenantRuntimeRepository(pool,{ ...scope,securityEpoch: randomUUID(),leasePool });
  await assert.rejects(stale.findCurrent(tenantId),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
});
