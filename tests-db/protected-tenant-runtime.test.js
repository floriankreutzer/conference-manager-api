import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';
import { withProtectedRuntimeExclusiveGate } from '../src/persistence/postgres/protected-runtime-gate.js';
import { createProtectedTenantProviderGate } from '../src/tenancy/protected-tenant-provider-gate.js';
import { ProtectedTenantRuntimeError } from '../src/tenancy/protected-tenant-runtime.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }

test('private protected registry preserves immutable mode, current owner/epoch, generation lifecycle and provider fencing',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const epoch=randomUUID(),operator=randomUUID(),foreignOperator=randomUUID(),generation=randomUUID();
  const real=randomUUID(),legacy=randomUUID(),slots=['northwind','contoso','fabrikam'].map(slot=>({ slot,tenantId: randomUUID() }));
  const runtime=createPostgresProtectedTenantRuntimeRepository(pool,{ environment: 'int',securityEpoch: epoch });
  const write=work=>withProtectedRuntimeExclusiveGate(pool,'int',work);
  async function seedOperator(id,provider=PLATFORM_ENTRA_PROVIDER) {
    await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles)
      VALUES($1::uuid,$2,'synthetic-directory',$1::text,ARRAY['platform_tenant_operator'])`,[id,provider]);
  }
  async function insertGeneration(id,owner=operator,version=1) {
    return pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
      VALUES('int',$1,$2,$3,$4)`,[id,owner,version,epoch]);
  }
  await t.test('empty059 rollback preserves accepted058/057 checksums and restores exact current readiness',async()=>{
    assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
    assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
    assert.equal(await rollbackLatest(pool),true); // Empty owner roles067.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty synthetic business060 before the unchanged059 probe.
    const before=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version IN (57,58) ORDER BY version')).rows;
    assert.equal(await rollbackLatest(pool),true);
    assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,58);
    await migrateUp(pool);
    assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,73);
    assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version IN (57,58) ORDER BY version')).rows,
      before);
    const guard=(await pool.query(`SELECT procedure.prosecdef,procedure.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) privilege
        WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc procedure WHERE procedure.oid='public.guard_protected_runtime_truncate()'::regprocedure`)).rows[0];
    assert.equal(guard.prosecdef,true);assert.deepEqual(guard.proconfig,['search_path=pg_catalog']);
    assert.equal(guard.public_execute,false);
  });
  await seedOperator(operator);await seedOperator(foreignOperator);
  await write(client=>client.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]));
  for (const tenantId of [real,legacy,...slots.map(value=>value.tenantId)]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic registry fixture','onboarding')",[tenantId]);
  }
  await t.test('unknown/foreign scope stays closed and real classification cannot be changed or deleted',async()=>{
    assert.equal(await runtime.findCurrent(legacy),null);
    await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real]);
    const current=await runtime.findCurrent(real);assert.equal(current.mode,'real');assert.equal(current.securityEpoch,epoch);
    assert.equal(current.generationId,null);assert.equal(current.operatorId,null);
    const foreign=createPostgresProtectedTenantRuntimeRepository(pool,{ environment: 'int',securityEpoch: randomUUID() });
    assert.equal(await foreign.findCurrent(real),null);
    await assert.rejects(pool.query("UPDATE tenant_runtime_registry SET mode='synthetic' WHERE tenant_id=$1",[real]),
      /TENANT_RUNTIME_CLASSIFICATION_IMMUTABLE/);
    await assert.rejects(pool.query('DELETE FROM tenant_runtime_registry WHERE tenant_id=$1',[real]),
      /TENANT_RUNTIME_CLASSIFICATION_IMMUTABLE/);
  });
  await t.test('generation intent requires a current real operator, current epoch and complete unique server slots',async()=>{
    await assert.rejects(insertGeneration(randomUUID(),operator,2),/SYNTHETIC_GENERATION_CREATION_DENIED/);
    const fake=randomUUID();await seedOperator(fake,'demo_platform');
    await assert.rejects(insertGeneration(randomUUID(),fake),/SYNTHETIC_GENERATION_CREATION_DENIED/);
    const customerProvider=randomUUID();await seedOperator(customerProvider,'microsoft_entra');
    await assert.rejects(insertGeneration(randomUUID(),customerProvider),/SYNTHETIC_GENERATION_CREATION_DENIED/);
    await insertGeneration(generation);
    await assert.rejects(pool.query(`UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp()
      WHERE id=$1`,[generation]),/SYNTHETIC_GENERATION_ACTIVATION_DENIED/);
    await assert.rejects(pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,'northwind')`,[legacy,generation,foreignOperator]),
    /TENANT_RUNTIME_SYNTHETIC_GENERATION_INVALID/);
    await assert.rejects(pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,NULL)`,[legacy,generation,operator]),error=>error.code==='23514');
    for (const { tenantId,slot } of slots) {
      await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
        VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generation,operator,slot]);
      assert.equal(await runtime.findCurrent(tenantId),null);
    }
    await assert.rejects(pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=2 WHERE id=$1",[generation]),
      error=>error.code==='23514'); // Missing activation timestamp cannot pass a nullable CHECK.
    await write(client=>client.query(`UPDATE synthetic_tenant_generations
      SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1`,[generation]));
    for (const { tenantId,slot } of slots) {
      const current=await runtime.findCurrent(tenantId);
      assert.equal(current.mode,'synthetic');assert.equal(current.slot,slot);assert.equal(current.operatorId,operator);
    }
  });
  await t.test('actual provider-mode lookup blocks real outbound and fences reset until the provider callback finishes',async()=>{
    let realAttempts=0,syntheticAttempts=0;
    const options={ repository: runtime,environment: 'int',securityEpoch: epoch };
    const realGate=createProtectedTenantProviderGate({ ...options,mode: 'real' });
    await assert.rejects(realGate.run(slots[0].tenantId,()=>{ realAttempts++; }),ProtectedTenantRuntimeError);
    assert.equal(realAttempts,0);
    const syntheticGate=createProtectedTenantProviderGate({ ...options,mode: 'synthetic' });
    const entered=deferred(),release=deferred();
    const pending=syntheticGate.run(slots[0].tenantId,async()=>{ syntheticAttempts++;entered.resolve();await release.promise; });
    await Promise.race([entered.promise,pending.then(()=>{ throw new Error('PROVIDER_CALLBACK_NOT_ENTERED'); })]);
    try {
      await assert.rejects(pool.query(`UPDATE synthetic_tenant_generations SET state='archived',revision=3,
        archived_at=clock_timestamp() WHERE id=$1`,[generation]),error=>error.code==='55P03');
    } finally { release.resolve();await pending; }
    assert.equal(syntheticAttempts,1);
    await assert.rejects(pool.query(`UPDATE synthetic_tenant_generations SET state='archived',revision=3,
      archived_at=clock_timestamp() WHERE id=$1`,[generation]),/SYNTHETIC_GENERATION_REQUIRES_TENANT_ARCHIVAL/);
  });
  await t.test('owner disable and whole-deployment epoch changes deny old generations without changing real classification',async()=>{
    await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[operator]);
    assert.equal(await runtime.findCurrent(slots[0].tenantId),null);assert.equal((await runtime.findCurrent(real)).mode,'real');
    await pool.query("UPDATE platform_operators SET status='active' WHERE id=$1",[operator]);
    assert.equal(await runtime.findCurrent(slots[0].tenantId),null); // Captured operator version cannot revive.
    const nextEpoch=randomUUID();
    await write(client=>client.query(`UPDATE protected_runtime_deployments
      SET security_epoch=$1,revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]));
    await assert.rejects(pool.query(`UPDATE protected_runtime_deployments
      SET security_epoch=$1,revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,[epoch]),
    error=>error.code==='23505'); // A former epoch can never be revived.
    await assert.rejects(pool.query("DELETE FROM protected_runtime_epoch_history WHERE environment='int'"),
      /PROTECTED_RUNTIME_EPOCH_HISTORY_IMMUTABLE/);
    assert.equal(await runtime.findCurrent(real),null);
    const next=createPostgresProtectedTenantRuntimeRepository(pool,{ environment: 'int',securityEpoch: nextEpoch });
    assert.equal((await next.findCurrent(real)).mode,'real');assert.equal(await next.findCurrent(slots[0].tenantId),null);
  });
  await t.test('archival retains old Tenant rows and immutable registry history; recovery cannot silently drop custody',async()=>{
    await write(async client=>{
      await client.query("UPDATE tenants SET status='archived' WHERE id=ANY($1::uuid[])",[slots.map(value=>value.tenantId)]);
      await client.query(`UPDATE synthetic_tenant_generations SET state='archived',revision=3,archived_at=clock_timestamp()
        WHERE id=$1`,[generation]);
    });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenants WHERE id=ANY($1::uuid[])',
      [slots.map(value=>value.tenantId)])).rows[0].count,3);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenant_runtime_registry WHERE generation_id=$1',
      [generation])).rows[0].count,3);
    await assert.rejects(pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=4 WHERE id=$1",[generation]),
      /SYNTHETIC_GENERATION_TRANSITION_INVALID/);
    assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
    assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
    assert.equal(await rollbackLatest(pool),true); // Empty owner roles067.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty060; populated059 retains its original recovery guard.
    await assert.rejects(rollbackLatest(pool),/PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
    await assert.rejects(pool.query(`TRUNCATE tenant_runtime_registry,synthetic_tenant_generations,
      protected_runtime_deployments,protected_runtime_epoch_history`),/PROTECTED_RUNTIME_CUSTODY_NOT_RESETTABLE/);
    await migrateUp(pool); // Restore current061 readiness after the unchanged populated059 probe.
  });
  await t.test('retained history has a hard per-owner generation bound and production cannot host synthetic generations',async()=>{
    const deployment=(await pool.query("SELECT security_epoch FROM protected_runtime_deployments WHERE environment='int'")).rows[0];
    const owner=(await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operator])).rows[0];
    await write(async client=>{
      const existing=(await client.query(`SELECT count(*)::int AS count FROM synthetic_tenant_generations
        WHERE environment='int' AND operator_id=$1`,[operator])).rows[0].count;
      for (let index=existing;index<32;index++) {
        await client.query(`INSERT INTO synthetic_tenant_generations
          (environment,id,operator_id,operator_security_version,security_epoch) VALUES('int',$1,$2,$3,$4)`,
        [randomUUID(),operator,owner.security_version,deployment.security_epoch]);
      }
    });
    await assert.rejects(pool.query(`INSERT INTO synthetic_tenant_generations
      (environment,id,operator_id,operator_security_version,security_epoch) VALUES('int',$1,$2,$3,$4)`,
    [randomUUID(),operator,owner.security_version,deployment.security_epoch]),/SYNTHETIC_GENERATION_CREATION_DENIED/);
    const productionEpoch=randomUUID();
    await withProtectedRuntimeExclusiveGate(pool,'prod',client=>client.query(
      "INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('prod',$1)",[productionEpoch]));
    await assert.rejects(pool.query(`INSERT INTO synthetic_tenant_generations
      (environment,id,operator_id,operator_security_version,security_epoch) VALUES('prod',$1,$2,$3,$4)`,
    [randomUUID(),operator,owner.security_version,productionEpoch]),error=>error.code==='23514');
  });
});
