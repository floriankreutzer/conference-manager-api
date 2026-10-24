import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createSyntheticTemplateMediaSource } from '../src/media/synthetic-template-media.js';
import { createSyntheticBusinessTemplates } from '../src/synthetic/business-templates.js';
import { migrateUp,rollbackLatest,loadMigrations } from '../scripts/db-migrations.mjs';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

test('native synthetic media preserves actual ownership, private privileges and retained history across lifecycle/epoch changes',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database }),roles=[];
  t.after(async()=>{
    try { for (const role of roles) { await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`); } }
    finally { await pool.end(); }
  });await migrateUp(pool);
  const accepted=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=59 ORDER BY version')).rows;
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061.
  assert.equal(await rollbackLatest(pool),true);
  assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,59);
  await migrateUp(pool);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=59 ORDER BY version')).rows,accepted);
  const suffix=randomUUID().replaceAll('-','').slice(0,10);
  for (const kind of ['customer','platform','reset']) {
    const role=`cm_syn_${kind}_${suffix}`;assert.match(role,/^[a-z][a-z0-9_]{2,62}$/);
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);roles.push(role);
  }
  await withPostgresTransaction(pool,async client=>{
    for (const [index,kind] of ['customer','platform','reset'].entries()) {
      await client.query('SELECT set_config($1,$2,true)',[`conference_manager.demo_${kind}_role`,roles[index]]);
    }
    await client.query((await loadMigrations('demo-migrations')).find(migration=>migration.version===26).up);
  });
  async function asRole(role,statement) {
    assert.ok(roles.includes(role));
    return withPostgresTransaction(pool,async client=>{ await client.query(`SET LOCAL ROLE ${role}`);return client.query(statement); });
  }
  for (const role of roles) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
      assert.equal((await pool.query("SELECT has_table_privilege($1,'synthetic_catalogue_media_assets',$2) AS allowed",
        [role,privilege])).rows[0].allowed,false);
    }
    await assert.rejects(asRole(role,'SELECT * FROM synthetic_catalogue_media_assets'),{ code: '42501' });
    await assert.rejects(asRole(role,'SELECT guard_synthetic_catalogue_media_truncate()'),{ code: '42501' });
  }
  await asRole(roles[2],'TRUNCATE synthetic_catalogue_media_assets');
  const guard=(await pool.query(`SELECT prosecdef,proconfig,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) privilege
      WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE oid='public.guard_synthetic_catalogue_media_truncate()'::regprocedure`)).rows[0];
  assert.equal(guard.prosecdef,true);assert.deepEqual(guard.proconfig,['search_path=pg_catalog']);assert.equal(guard.public_execute,false);

  const customer=await createInvitedCustomerFixture(pool,t),epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[customer.tenantId]);
  const realState=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM users WHERE tenant_id=$1) AS users,
    (SELECT count(*)::int FROM sessions WHERE tenant_id=$1) AS sessions,
    (SELECT count(*)::int FROM customer_access_memberships WHERE tenant_id=$1) AS memberships,
    (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1) AS audit`,[customer.tenantId])).rows[0];
  const sourceId=createSyntheticBusinessTemplates()[0].catalogueMedia[0].id;
  const media=await createSyntheticTemplateMediaSource().read(sourceId);
  async function tenantBusiness(tenantId) {
    const userId=randomUUID(),siteId=randomUUID(),roomId=randomUUID();
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic media creator')",[tenantId,userId]);
    await pool.query("INSERT INTO sites(tenant_id,id,name,time_zone) VALUES($1,$2,'Synthetic site','Europe/Berlin')",[tenantId,siteId]);
    await pool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity) VALUES($1,$2,$3,'Synthetic room',8)",
      [tenantId,roomId,siteId]);
    return { tenantId,userId,roomId,siteId };
  }
  const foreign=await tenantBusiness(customer.tenantId),preserved=await realState();
  async function ownedGeneration() {
    const operatorId=randomUUID(),generationId=randomUUID(),tenantIds=[];
    await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles)
      VALUES($1::uuid,$2,'synthetic-directory',$1::text,ARRAY['platform_tenant_operator'])`,[operatorId,PLATFORM_ENTRA_PROVIDER]);
    await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
      VALUES('int',$1,$2,1,$3)`,[generationId,operatorId,epoch]);
    for (const slot of ['northwind','contoso','fabrikam']) {
      const tenantId=randomUUID();tenantIds.push(tenantId);
      await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic media tenant','onboarding')",[tenantId]);
      await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
        VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generationId,operatorId,slot]);
    }
    return { ...await tenantBusiness(tenantIds[0]),tenantIds,generationId,operatorId };
  }
  async function insert(owner,overrides={}) {
    const row={ id: randomUUID(),ownerKind: 'room_plan',ownerId: owner.roomId,userId: owner.userId,...overrides };
    await pool.query(`INSERT INTO synthetic_catalogue_media_assets(tenant_id,id,owner_kind,owner_id,bytes,content_type,
      byte_length,content_sha256,alt_text,created_at,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Synthetic room plan',clock_timestamp(),$9)`,
    [owner.tenantId,row.id,row.ownerKind,row.ownerId,media.bytes,media.contentType,media.byteLength,
      Buffer.from(media.sha256,'hex'),row.userId]);return row.id;
  }
  const owner=await ownedGeneration(),assetId=await insert(owner);
  await pool.query(`UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp()
    WHERE id=$1`,[owner.generationId]);
  await pool.query('UPDATE synthetic_catalogue_media_assets SET alt_text=$2 WHERE id=$1',[assetId,'Current active generation']);
  await assert.rejects(insert(foreign),{ code: '23514' }); // Explicit real mode cannot own synthetic media.
  const spareRoom=randomUUID();
  await pool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity) VALUES($1,$2,$3,'Synthetic spare room',8)",
    [owner.tenantId,spareRoom,owner.siteId]);
  await assert.rejects(insert(owner,{ ownerId: spareRoom,userId: foreign.userId }),{ code: '23503' });
  await assert.rejects(insert(owner,{ ownerId: foreign.roomId }),{ code: '23503' });
  await assert.rejects(insert(owner,{ ownerKind: 'catering_item' }),{ code: '23503' });
  await assert.rejects(pool.query('DELETE FROM rooms WHERE tenant_id=$1 AND id=$2',[owner.tenantId,owner.roomId]),
    { code: '23001',constraint: 'synthetic_catalogue_media_assets_tenant_id_room_id_fkey' });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM rooms WHERE tenant_id=$1 AND id=$2',
    [owner.tenantId,owner.roomId])).rows[0].count,1);
  await assert.rejects(pool.query('UPDATE synthetic_catalogue_media_assets SET owner_id=$2 WHERE id=$1',
    [assetId,foreign.roomId]),/SYNTHETIC_MEDIA_OWNERSHIP_IMMUTABLE/);
  const removable=await insert(owner,{ ownerId: spareRoom });
  assert.equal((await pool.query('DELETE FROM synthetic_catalogue_media_assets WHERE id=$1',[removable])).rowCount,1);
  await assert.rejects(asRole(roles[2],'TRUNCATE synthetic_catalogue_media_assets'),{ code: '55000' });
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before populated060.
  await assert.rejects(rollbackLatest(pool),/SYNTHETIC_BUSINESS_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  const retained=(await pool.query('SELECT bytes,content_sha256 FROM synthetic_catalogue_media_assets WHERE id=$1',[assetId])).rows[0];
  assert.deepEqual(retained.bytes,media.bytes);assert.equal(retained.content_sha256.toString('hex'),media.sha256);
  await pool.query("UPDATE tenants SET status='archived' WHERE id=ANY($1::uuid[])",[owner.tenantIds]);
  await assert.rejects(pool.query('UPDATE synthetic_catalogue_media_assets SET alt_text=$2 WHERE id=$1',
    [assetId,'Forbidden archived edit']),/SYNTHETIC_MEDIA_SCOPE_DENIED/);
  await assert.rejects(pool.query('DELETE FROM synthetic_catalogue_media_assets WHERE id=$1',[assetId]),/SYNTHETIC_MEDIA_SCOPE_DENIED/);
  const disabled=await ownedGeneration(),disabledAsset=await insert(disabled);
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[disabled.operatorId]);
  await assert.rejects(pool.query('UPDATE synthetic_catalogue_media_assets SET alt_text=$2 WHERE id=$1',
    [disabledAsset,'Forbidden disabled owner edit']),/SYNTHETIC_MEDIA_SCOPE_DENIED/);
  const oldEpoch=await ownedGeneration(),epochAsset=await insert(oldEpoch);
  await pool.query(`UPDATE protected_runtime_deployments
    SET security_epoch=$1,revision=2,updated_at=clock_timestamp() WHERE environment='int'`,
    [randomUUID()]);
  await assert.rejects(pool.query('UPDATE synthetic_catalogue_media_assets SET alt_text=$2 WHERE id=$1',
    [epochAsset,'Forbidden old epoch edit']),/SYNTHETIC_MEDIA_SCOPE_DENIED/);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_catalogue_media_assets')).rows[0].count,3);
  assert.deepEqual(await realState(),preserved);
  await migrateUp(pool); // Restore061 after the unchanged populated060 rollback probe.
  assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,67);
});
