import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';
import { createPostgresProtectedTenantRuntimeRepository } from '../src/persistence/postgres/protected-tenant-runtime-repository.js';

test('native exact-proof generation replacement seeds business state, retains owned history and preserves real access',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const real=await createInvitedCustomerFixture(pool,t);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const preserved=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM users WHERE tenant_id=$1) AS users,
    (SELECT count(*)::int FROM sessions WHERE tenant_id=$1) AS sessions,
    (SELECT count(*)::int FROM customer_access_memberships WHERE tenant_id=$1) AS memberships,
    (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1) AS audit`,[real.tenantId])).rows[0];
  const beforeReal=await preserved(),owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const other=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  function service(operator,audit=real.auditRepository) {
    return createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,passkeyService: operator.auth,
      authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,
        { environment: 'int',securityEpoch: epoch,tenantAuditRepository: audit,platformAuditRepository: operator.auditRepository }) });
  }
  const own=service(owner),foreign=service(other);
  async function replace(operator,application,previous=null) {
    const intent={ operatorId: operator.operatorId,expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 },correlationId=randomUUID();
    return operator.execute(application.operationHash(intent),proofContext=>application.replace({ proofContext,intent,correlationId }));
  }
  const first=await replace(owner,own),another=await replace(other,foreign);
  assert.equal(first.revision,2);assert.deepEqual(first.tenants.map(row=>row.slot),['northwind','contoso','fabrikam']);
  assert.deepEqual(first.tenants.map(row=>row.status),['active','ready','onboarding']);
  const ids=first.tenants.map(row=>row.tenantId),foreignIds=another.tenants.map(row=>row.tenantId);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_operator_tenant_scopes')).rows[0].count,0);
  async function business(tenantIds) {
    return (await pool.query(`SELECT tenant.id,tenant.status,tenant.lifecycle_revision,
      (SELECT count(*)::int FROM rooms WHERE tenant_id=tenant.id) AS rooms,
      (SELECT count(*)::int FROM requests WHERE tenant_id=tenant.id) AS requests,
      (SELECT count(*)::int FROM users WHERE tenant_id=tenant.id) AS users,
      (SELECT count(*)::int FROM tenant_room_media_assets WHERE tenant_id=tenant.id) AS room_media,
      (SELECT count(*)::int FROM synthetic_catalogue_media_assets WHERE tenant_id=tenant.id) AS catalogue_media
      FROM tenants tenant WHERE tenant.id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],tenant.id)`,[tenantIds])).rows;
  }
  const firstState=await business(ids),foreignState=await business(foreignIds);
  assert.deepEqual(firstState.map(row=>row.rooms),[10,2,0]);
  assert.deepEqual(firstState.map(row=>row.requests),[20,3,0]);assert.deepEqual(firstState.map(row=>row.users),[3,3,3]);
  assert.ok(firstState[0].room_media>0);assert.ok(firstState[0].catalogue_media>0);
  const identities=(await pool.query(`SELECT provider,provider_tenant_reference FROM user_identity_bindings
    WHERE tenant_id=ANY($1::uuid[])`,[ids])).rows;
  assert.equal(identities.length,9);assert.ok(identities.every(row=>row.provider==='platform_delegation'
    && row.provider_tenant_reference===first.generationId));
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM customer_access_memberships
    WHERE tenant_id=ANY($1::uuid[])`,[ids])).rows[0].count,0);
  await assert.rejects(replace(owner,own,first),/SYNTHETIC_GENERATION_COOLDOWN/);
  assert.deepEqual(await business(ids),firstState);assert.deepEqual(await business(foreignIds),foreignState);
  // This is the actual domain cooldown, not a retry of a failed operation.
  // The next call creates a new challenge, fresh signature and command intent.
  await new Promise(resolve=>setTimeout(resolve,10_100));
  const wrong={ ...first,generationId: another.generationId };
  await assert.rejects(replace(owner,own,wrong),/SYNTHETIC_GENERATION_STALE/);
  const allBusiness=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM tenants) AS tenants,(SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM requests) AS requests,(SELECT count(*)::int FROM synthetic_tenant_generations) AS generations,
    (SELECT count(*)::int FROM tenant_runtime_registry) AS registry,
    (SELECT count(*)::int FROM tenant_room_media_assets) AS rooms,
    (SELECT count(*)::int FROM synthetic_catalogue_media_assets) AS media,
    (SELECT count(*)::int FROM audit_events) AS audit`)).rows[0];
  const rollbackBefore=await allBusiness();
  const failing=service(owner,{ async appendWithClient() { throw new Error('SYNTHETIC_REQUIRED_AUDIT_FAILED'); } });
  await assert.rejects(replace(owner,failing,first),/SYNTHETIC_REQUIRED_AUDIT_FAILED/);
  assert.deepEqual(await allBusiness(),rollbackBefore);assert.deepEqual(await business(ids),firstState);
  const second=await replace(owner,own,first),newIds=second.tenants.map(row=>row.tenantId);
  const secondState=await business(newIds);
  assert.ok(newIds.every(id=>!ids.includes(id) && !foreignIds.includes(id)));
  const archived=await business(ids);
  assert.ok(archived.every(row=>row.status==='archived' && Number(row.lifecycle_revision)===2));
  assert.deepEqual(archived.map(({ status,lifecycle_revision,...row })=>row),
    firstState.map(({ status,lifecycle_revision,...row })=>row));
  assert.deepEqual(await business(foreignIds),foreignState);assert.deepEqual(await preserved(),beforeReal);
  assert.ok(await real.sessions.resolvePrincipal({ headers: { cookie: real.cookie } }));
  assert.equal(await real.auditRepository.verifyTenantChain(real.tenantId),true);
  for (const tenantId of [...ids,...newIds,...foreignIds]) assert.equal(await real.auditRepository.verifyTenantChain(tenantId),true);
  const generations=(await pool.query(`SELECT id,state,revision,operator_security_version
    FROM synthetic_tenant_generations WHERE environment='int' AND operator_id=$1 ORDER BY created_at`,[owner.operatorId])).rows;
  assert.deepEqual(generations.map(row=>[row.state,Number(row.revision),Number(row.operator_security_version)]),
    [['archived',3,3],['active',2,3]]);
  const actor=(await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[owner.operatorId])).rows[0];
  assert.equal(Number(actor.security_version),3);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM platform_audit_events
    WHERE operator_id=$1 AND target_tenant_id=ANY($2::uuid[])`,[owner.operatorId,[...ids,...newIds]])).rows[0].count,9);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM platform_passkey_auth_transactions
    WHERE operator_id=$1 AND expires_at>clock_timestamp()`,[owner.operatorId])).rows[0].count,5);

  await t.test('fresh authorized owner can archive a stale captured operator version without rewriting its retained history',async()=>{
    // This independent scenario has its own owner and genuine ceremonies. The
    // earlier five retained ceremonies must not bypass the production cap.
    const recovering=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch }),recoveryService=service(recovering);
    const captured=await replace(recovering,recoveryService);
    const key=platformPasskeyFixture({ operatorId: recovering.operatorId });
    await pool.query(`INSERT INTO platform_passkey_credentials
      (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
      VALUES($1,$2,'int',$3,$4,$5,0,false,false)`,
    [randomUUID(),recovering.operatorId,key.credential.id,key.credential.publicKey,key.userHandle]);
    const runtime=createPostgresProtectedTenantRuntimeRepository(pool,{ environment: 'int',securityEpoch: epoch });
    assert.equal(await runtime.findCurrent(captured.tenants[0].tenantId),null);
    assert.equal(await recovering.sessions.resolvePrincipal({ headers: { cookie: recovering.current().setCookie.split(';')[0] } }),null);
    await recovering.freshSession();
    await new Promise(resolve=>setTimeout(resolve,10_100));
    const replacement=await replace(recovering,recoveryService,captured);
    const retained=(await pool.query(`SELECT state,operator_security_version FROM synthetic_tenant_generations
      WHERE environment='int' AND operator_id=$1 ORDER BY created_at`,[recovering.operatorId])).rows;
    assert.deepEqual(retained.map(row=>[row.state,Number(row.operator_security_version)]),
      [['archived',3],['active',4]]);
    assert.ok(await runtime.findCurrent(replacement.tenants[0].tenantId));
    assert.deepEqual(await business(newIds),secondState);
    assert.deepEqual(await business(foreignIds),foreignState);assert.deepEqual(await preserved(),beforeReal);
  });

  await t.test('retained generation quota preserves history, business data and prior session on denial',async()=>{
    const bounded=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch }),application=service(bounded);
    await bounded.scopes.withSyntheticExclusive({ operatorId: bounded.operatorId,operatorSecurityVersion: 3 },async client=>{
      for (let index=0;index<32;index++) await client.query(`INSERT INTO synthetic_tenant_generations
        (environment,id,operator_id,operator_security_version,security_epoch,created_at)
        VALUES('int',$1,$2,3,$3,clock_timestamp()-interval '1 hour')`,[randomUUID(),bounded.operatorId,epoch]);
    });
    const retained=await allBusiness(),session=bounded.current().setCookie;
    await assert.rejects(replace(bounded,application),/SYNTHETIC_GENERATION_RETENTION_LIMIT/);
    assert.deepEqual(await allBusiness(),retained);
    assert.ok(await bounded.sessions.resolvePrincipal({ headers: { cookie: session.split(';')[0] } }));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM synthetic_tenant_generations
      WHERE operator_id=$1`,[bounded.operatorId])).rows[0].count,32);
  });
});
