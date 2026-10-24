import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';

test('native first owner bootstrap is atomic, one-winner, audited, owner-only and permanently fenced after disable',async t=>{
  const pool=createPostgresPool({ mode: 'test',...loadDatabaseConfig(process.env,'test'),databasePoolMax: 3 });
  t.after(()=>pool.end());await migrateUp(pool);
  const expected={ environment: 'int',deploymentEpoch: randomUUID(),directoryId: randomUUID(),subjectId: randomUUID() };
  await pool.query('INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES($1,$2)',
    ['int',expected.deploymentEpoch]);
  const role=(await pool.query('SELECT current_user AS role')).rows[0].role;
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'b'.repeat(48) });
  const request={ ...expected,approvalReference: 'INT-OWNER-APPROVED',correlationId: randomUUID() };
  const create=options=>createPostgresPlatformOwnerBootstrapRepository(pool,
    { expected,expectedOfflineRole: role,auditRepository: audit,...options });
  await pool.query(`INSERT INTO platform_operators
    (id,provider,provider_tenant_reference,provider_subject_reference,roles)
    VALUES($1,'demo_platform','fixture-directory','fixture-owner',ARRAY['platform_security_admin'])`,[randomUUID()]);
  const count=async()=>(await pool.query("SELECT count(*)::int AS count FROM platform_operators WHERE provider<>'demo_platform'"))
    .rows[0].count;
  await assert.rejects(create({ expectedOfflineRole: 'wrong_owner' }).initialize(request),/BOOTSTRAP_REFUSED/);
  assert.equal(await count(),0);
  await assert.rejects(create({ auditRepository: { async appendWithClient() { throw new Error('private-cause'); } } })
    .initialize(request),{ message: 'PLATFORM_OWNER_BOOTSTRAP_REFUSED' });
  assert.equal(await count(),0);
  await assert.rejects(create({ auditRepository: { async appendWithClient() { return null; } } })
    .initialize(request),{ message: 'PLATFORM_OWNER_BOOTSTRAP_REFUSED' });
  assert.equal(await count(),0);
  const other={ ...expected,deploymentEpoch: randomUUID() };
  await assert.rejects(create({ expected: other }).initialize({ ...request,...other }),/BOOTSTRAP_REFUSED/);
  const outcomes=await Promise.allSettled([create().initialize(request),create().initialize(request)]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);assert.equal(await count(),1);
  const operator=(await pool.query(`SELECT id,provider,status,scope_mode,roles,security_version
    FROM platform_operators WHERE provider<>'demo_platform'`)).rows[0];
  assert.equal(operator.provider,'microsoft_entra_platform');assert.equal(operator.status,'active');
  assert.equal(operator.scope_mode,'all');assert.equal(Number(operator.security_version),1);
  assert.deepEqual(operator.roles,['platform_security_admin','platform_tenant_operator']);
  const events=await audit.listVerified({ scope: { mode: 'all',operatorId: operator.id,securityVersion: 1 } });
  assert.equal(events.length,1);assert.equal(events[0].targetType,'platform_operator_bootstrap');
  assert.equal(events[0].assuranceLevel,'offline_owner');assert.deepEqual(events[0].roles,[]);
  assert.doesNotMatch(JSON.stringify(events),new RegExp(expected.subjectId));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_operator_change_alert_outbox')).rows[0].count,1);
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner-role067.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 leaves the original065 owner guard intact.
  await assert.rejects(rollbackLatest(pool),{ code: '55000' });
  assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version,65);
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[operator.id]);
  await assert.rejects(create().initialize({ ...request,correlationId: randomUUID() }),/BOOTSTRAP_REFUSED/);
  assert.equal(await count(),1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_operators WHERE provider='demo_platform'"))
    .rows[0].count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_sessions')).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
});
