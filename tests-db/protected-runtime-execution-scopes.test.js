import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresProtectedRuntimeExecutionScopes,requireProtectedRuntimeSharedExecutionScope }
  from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

test('native protected execution uses max1 pools without isolation downgrade and rejects stale RR custody snapshots',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 2 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),nextEpoch=randomUUID(),operatorId=randomUUID();
  const owner={ operatorId,operatorSecurityVersion: 1 };
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles)
    VALUES($1::uuid,$2,'synthetic-directory',$1::text,ARRAY['platform_tenant_operator'])`,[operatorId,PLATFORM_ENTRA_PROVIDER]);
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const make=(business=pool,securityEpoch=epoch)=>createPostgresProtectedRuntimeExecutionScopes({
    pool: business,leasePool,environment: 'int',securityEpoch });
  const scopes=make(),inner=make(),scope={ environment: 'int',securityEpoch: epoch };
  const originalStamp=(await pool.query('SELECT updated_at FROM platform_operators WHERE id=$1',[operatorId])).rows[0].updated_at;
  await scopes.withShared(async()=>{
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value,1);
    await withPostgresTransaction(pool,async client=>{
      assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');
      assert.equal(await inner.withShared(()=>withPostgresTransaction(pool,async nested=>nested===client,
        { isolationLevel: 'REPEATABLE READ' })),true);
      assert.equal(requireProtectedRuntimeSharedExecutionScope(pool,scope),true);
    },{ isolationLevel: 'REPEATABLE READ' });
    await assert.rejects(withPostgresTransaction(pool,()=>inner.withShared(async()=>{
      await withPostgresTransaction(pool,client=>client.query('UPDATE platform_operators SET updated_at=clock_timestamp() WHERE id=$1',
        [operatorId]),{ isolationLevel: 'REPEATABLE READ' });
      throw new Error('JOINED_BUSINESS_ROLLBACK');
    }),{ isolationLevel: 'REPEATABLE READ' }),/JOINED_BUSINESS_ROLLBACK/);
    assert.equal(requireProtectedRuntimeSharedExecutionScope(pool,scope),true);
    assert.equal((await pool.query('SELECT updated_at FROM platform_operators WHERE id=$1',[operatorId])).rows[0].updated_at.getTime(),
      originalStamp.getTime());
    // A concurrent reset through a separate async root must reject immediately,
    // rather than waiting for this request's shared lease or exhausting its pool.
    await assert.rejects(control.query('SELECT protected_runtime_acquire_exclusive($1)',['int']),/PROTECTED_RUNTIME_BUSY/);
  });
  await scopes.withSyntheticExclusive(owner,async client=>{
    assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');
    assert.equal(await withPostgresTransaction(pool,async nested=>nested===client,{ isolationLevel: 'REPEATABLE READ' }),true);
    assert.equal(Number((await client.query('SELECT security_version FROM platform_operators WHERE id=$1',
      [operatorId])).rows[0].security_version),1);
  });
  const stamp=(await pool.query('SELECT updated_at FROM platform_operators WHERE id=$1',[operatorId])).rows[0].updated_at;
  await assert.rejects(scopes.withSyntheticExclusive(owner,async()=>{ throw new Error('SYNTHETIC_PROOF_OR_MUTATION_FAILED'); }),
    /SYNTHETIC_PROOF_OR_MUTATION_FAILED/);
  assert.equal((await pool.query('SELECT updated_at FROM platform_operators WHERE id=$1',[operatorId])).rows[0].updated_at.getTime(),
    stamp.getTime());
  let called=0;
  await assert.rejects(scopes.withSyntheticExclusive({ ...owner,operatorSecurityVersion: 2 },async()=>{ called++; }),
    { code: 'PROTECTED_OPERATOR_SCOPE_STALE' });assert.equal(called,0);

  function snapshotBeforeLease(change) {
    let pending=true;
    return { query: (...args)=>pool.query(...args),async connect() {
      const client=await pool.connect();
      return { async query(input,...args) {
        if (pending && typeof input==='object' && input.text.includes('pg_try_advisory_xact_lock(')) {
          pending=false;
          // Instrument only this isolated native fixture: force the real RR
          // snapshot just before another transaction commits and the gate locks.
          await client.query("SELECT security_epoch FROM protected_runtime_deployments WHERE environment='int'");await change();
        }
        return client.query(input,...args);
      },release: error=>client.release(error) };
    } };
  }
  const staleEpoch=snapshotBeforeLease(()=>control.query(`UPDATE protected_runtime_deployments
    SET security_epoch=$1,revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]));
  await assert.rejects(make(staleEpoch).withSyntheticExclusive(owner,async()=>{ called++; }),{ code: '40001' });
  assert.equal(called,0);
  await assert.rejects(scopes.withShared(async()=>{ called++; }),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  const staleOwner=snapshotBeforeLease(()=>control.query('UPDATE platform_operators SET updated_at=clock_timestamp() WHERE id=$1',
    [operatorId]));
  await assert.rejects(make(staleOwner,nextEpoch).withSyntheticExclusive(owner,async()=>{ called++; }),{ code: '40001' });
  assert.equal(called,0);
  await make(pool,nextEpoch).withSyntheticExclusive(owner,async client=>{
    assert.equal(Number((await client.query('SELECT security_version FROM platform_operators WHERE id=$1',
      [operatorId])).rows[0].security_version),1);
  });
});
