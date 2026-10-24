import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { migrateUp,rollbackLatest,loadMigrations } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

test('native private calendar enforces current synthetic custody, overlap serialization, terminal cancellation and retained history',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 2 });
  const lease=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const role=`cm_syn_calendar_${randomBytes(5).toString('hex')}`;
  t.after(async()=>{
    try { await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`); }
    finally { await Promise.all([pool.end(),lease.end()]); }
  });await migrateUp(pool);
  assert.equal((await pool.query("SELECT protected_lock_synthetic_calendar_source('int',$1,$2) AS allowed",
    [randomUUID(),randomUUID()])).rows[0].allowed,false);
  const original=(await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=62 ORDER BY version')).rows;
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty064 before original063 proof.
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool);
  assert.deepEqual((await pool.query('SELECT version,checksum FROM schema_migrations WHERE version<=62 ORDER BY version')).rows,original);
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const migrations=await loadMigrations('demo-migrations');
  await withPostgresTransaction(pool,async client=>{
    for (const kind of ['customer','platform','reset']) await client.query('SELECT set_config($1,$2,true)',
      [`conference_manager.demo_${kind}_role`,role]);
    await client.query(migrations.find(row=>row.version===28).up);
  });
  for (const name of ['synthetic_calendar_events','synthetic_calendar_resources']) {
    for (const permission of ['SELECT','INSERT','UPDATE','DELETE']) assert.equal((await pool.query(
      'SELECT has_table_privilege($1,$2,$3) AS allowed',[role,name,permission])).rows[0].allowed,false);
  }
  async function asRole(statement,values=[]) {
    return withPostgresTransaction(pool,async client=>{ await client.query(`SET LOCAL ROLE ${role}`);
      return client.query(statement,values); });
  }
  await asRole('TRUNCATE synthetic_calendar_events,synthetic_calendar_resources');
  for (const name of ['guard_synthetic_calendar_event','guard_synthetic_calendar_resource','guard_synthetic_calendar_truncate']) {
    await assert.rejects(asRole(`SELECT ${name}()`),{ code: '42501' });
    const policy=(await pool.query(`SELECT prosecdef,proconfig,EXISTS(SELECT 1
      FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) acl
      WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute FROM pg_proc WHERE oid=$1::regprocedure`,[`${name}()`])).rows[0];
    assert.equal(policy.prosecdef,true);assert.deepEqual(policy.proconfig,['search_path=pg_catalog']);
    assert.equal(policy.public_execute,false);
  }
  await assert.rejects(asRole("SELECT protected_lock_synthetic_calendar_source('int',$1,$2)",
    [randomUUID(),randomUUID()]),{ code: '42501' });
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,lease,{ epoch });
  const application=createSyntheticGenerationService({ ...scope,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,{ ...scope,
      tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) }),
      platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(application.operationHash(intent),proofContext=>application.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const tenantId=generation.tenants.find(row=>row.slot==='northwind').tenantId,integrationId=randomUUID();
  const roomId=(await pool.query('SELECT id FROM rooms WHERE tenant_id=$1 ORDER BY id LIMIT 1',[tenantId])).rows[0].id;
  const requests=(await pool.query('SELECT id FROM requests WHERE tenant_id=$1 ORDER BY id LIMIT 3',[tenantId])).rows.map(row=>row.id);
  await pool.query(`INSERT INTO integrations(tenant_id,id,provider,provider_reference,status)
    VALUES($1,$2,'synthetic_calendar',$3,'active')`,[tenantId,integrationId,`synthetic:${generation.generationId}`]);
  const resource=[epoch,tenantId,generation.generationId,integrationId,roomId];
  const resourceSql=`INSERT INTO synthetic_calendar_resources(environment,security_epoch,tenant_id,generation_id,integration_id,room_id)
    VALUES('int',$1,$2,$3,$4,$5)`;
  await pool.query(resourceSql,resource);
  await assert.rejects(pool.query('UPDATE synthetic_calendar_resources SET revision=revision+1 WHERE tenant_id=$1',[tenantId]),
    /SYNTHETIC_CALENDAR_RESOURCE_IMMUTABLE/);
  await pool.query(`GRANT SELECT ON synthetic_calendar_resources TO ${role}`);
  await pool.query(`GRANT SELECT,INSERT,UPDATE ON synthetic_calendar_events TO ${role}`);
  const eventSql=`INSERT INTO synthetic_calendar_events(environment,security_epoch,tenant_id,generation_id,integration_id,room_id,
    id,request_id,idempotency_key,starts_at,ends_at,state) VALUES('int',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING id`;
  const eventValues=(request=0,start='2028-01-01T10:00:00.000Z',end='2028-01-01T11:00:00.000Z')=>[
    ...resource,randomUUID(),requests[request],randomBytes(32).toString('hex'),start,end];
  for (const [position,value] of [[0,randomUUID()],[1,generation.tenants.find(row=>row.slot==='contoso').tenantId],
    [2,randomUUID()],[3,randomUUID()],[4,'foreign-room']]) {
    const malformed=eventValues();malformed[position]=value;
    await assert.rejects(asRole(eventSql,malformed),/SYNTHETIC_CALENDAR_SCOPE_DENIED/);
  }
  const real=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Calendar REAL tripwire','active')",[real]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real]);
  const realAttempt=eventValues();realAttempt[1]=real;
  await assert.rejects(asRole(eventSql,realAttempt),/SYNTHETIC_CALENDAR_SCOPE_DENIED/);
  const foreignLogin=await pool.connect();
  try {
    await foreignLogin.query(`SET SESSION AUTHORIZATION ${role}`);
    await assert.rejects(foreignLogin.query(eventSql,eventValues()),{ code: '42501' });
  } finally { foreignLogin.release(new Error('DISCARD_FOREIGN_SESSION_AUTHORIZATION')); }
  const first=eventValues();await asRole(eventSql,first);
  await assert.rejects(asRole(eventSql,eventValues(1)),{ code: '23P01' });
  await assert.rejects(asRole(eventSql,[...first]),{ code: '23505' });
  const neighbour=eventValues(1,'2028-01-01T11:00:00.000Z','2028-01-01T12:00:00.000Z');await asRole(eventSql,neighbour);
  const cancel=`UPDATE synthetic_calendar_events SET state='cancelled',revision=revision+1,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND id=$2`;
  await asRole(cancel,[tenantId,first[5]]);
  await assert.rejects(asRole(cancel,[tenantId,first[5]]),/SYNTHETIC_CALENDAR_TRANSITION_INVALID/);
  // A pre-existing RR snapshot cannot admit a new overlap after another commit.
  const stale=await pool.connect();
  try {
    await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await stale.query(`SET LOCAL ROLE ${role}`);
    await stale.query('SELECT count(*) FROM synthetic_calendar_events');
    const current=eventValues(0);await asRole(eventSql,current);
    await assert.rejects(stale.query(eventSql,eventValues(2)),{ code: '40001' });
  } finally { await stale.query('ROLLBACK');stale.release(); }
  // Two concurrent committed API-shaped writes serialize on the actual room tuple.
  const concurrent=await Promise.allSettled([2,2].map(()=>asRole(eventSql,eventValues(2,
    '2028-01-02T10:00:00.000Z','2028-01-02T11:00:00.000Z'))));
  assert.equal(concurrent.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(concurrent.find(row=>row.status==='rejected').reason.code,'23P01');
  const retained=(await pool.query('SELECT id,state,revision,starts_at,ends_at FROM synthetic_calendar_events ORDER BY id')).rows;
  await assert.rejects(asRole('TRUNCATE synthetic_calendar_events,synthetic_calendar_resources'),{ code: '55000' });
  const calendarDown=(await loadMigrations()).find(row=>row.version===63).down;
  await assert.rejects(withPostgresTransaction(pool,client=>client.query(calendarDown)),
    /SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY/); // Preserve the actual063 populated down proof.
  await assert.rejects(pool.query('DELETE FROM synthetic_calendar_events WHERE tenant_id=$1',[tenantId]),{ code: '42501' });
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operatorId]);
  await assert.rejects(asRole(eventSql,eventValues(2,'2028-01-03T10:00:00.000Z','2028-01-03T11:00:00.000Z')),
    /SYNTHETIC_CALENDAR_SCOPE_DENIED/);
  await assert.rejects(asRole(cancel,[tenantId,neighbour[5]]),/SYNTHETIC_CALENDAR_SCOPE_DENIED/);
  const after=(await pool.query('SELECT id,state,revision,starts_at,ends_at FROM synthetic_calendar_events ORDER BY id')).rows;
  assert.deepEqual(after,retained);
});
