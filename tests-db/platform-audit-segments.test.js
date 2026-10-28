import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformAuditSegmentInitializer } from '../src/persistence/postgres/platform-audit-segment-initializer.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles,grantPlatformAuditSegmentRuntimeRoles,grantCustomerMicrosoftGroupRuntimeRoles,
  grantPlatformMicrosoftOperationRuntimeRoles }
  from '../scripts/support/protected-runtime-role-grants.mjs';

const anonymous=()=>({ operatorId: null,roles: [],permissions: [],assuranceLevel: 'unverified',targetTenantId: null,
  action: 'platform.authentication.failed',targetType: 'authentication',targetId: 'platform',previousState: null,newState: null,
  occurredAt: new Date().toISOString(),correlationId: randomUUID(),outcome: 'failure',metadata: { reasonCode: 'identity_unmapped' },
  retentionClass: 'security' });

test('native audit cutover preserves all legacy bytes, commits one genesis and aligns checkpoints locally',async t=>{
  const pool=createPostgresPool({ mode: 'test',...loadDatabaseConfig(process.env,'test'),databasePoolMax: 3 });
  const created=[];
  t.after(async()=>{
    try {
      for (const name of created.reverse()) {
        await pool.query(`DROP OWNED BY "${name}"`);await pool.query(`DROP ROLE "${name}"`);
      }
    } finally { await pool.end(); }
  });await migrateUp(pool);
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067.
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool);
  const deploymentEpoch=randomUUID(),segmentId=randomUUID();
  await pool.query('INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES($1,$2)',['int',deploymentEpoch]);
  const operatorId=randomUUID();
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles,scope_mode)
    VALUES($1,'demo_platform','demo-directory','demo-auditor',ARRAY['platform_security_auditor'],'all')`,[operatorId]);
  const legacy=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'old-test-key-'.repeat(4) });
  for (let index=0;index<124;index++) await legacy.append(anonymous());
  const inventory=async()=>(await pool.query('SELECT platform_legacy_audit_inventory() AS inventory')).rows[0].inventory;
  const before=await inventory();assert.equal(Number(before.eventCount),124);
  const timezone=await pool.connect();
  try {
    await timezone.query('BEGIN');await timezone.query("SET LOCAL TIME ZONE 'Pacific/Auckland'");
    assert.deepEqual((await timezone.query('SELECT platform_legacy_audit_inventory() AS inventory')).rows[0].inventory,before);
  } finally { await timezone.query('ROLLBACK');timezone.release(); }
  const oldRows=(await pool.query('SELECT to_jsonb(e) AS value FROM platform_audit_events e ORDER BY sequence')).rows;
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'new-test-key-'.repeat(4),
    segment: { id: segmentId,environment: 'int',deploymentEpoch } });
  const expected={ environment: 'int',segmentId,deploymentEpoch,legacyEventCount: 124,inventoryDigest: before.digest };
  const request={ ...expected,approvalReference: 'INT-CUTOVER-APPROVED',correlationId: randomUUID() };
  const role=(await pool.query('SELECT current_user AS role')).rows[0].role;
  const initializer=options=>createPostgresPlatformAuditSegmentInitializer(pool,
    { expected,expectedOfflineRole: role,auditRepository: audit,...options });
  await assert.rejects(initializer({ expectedOfflineRole: 'wrong_owner' }).initialize(request),/INITIALIZATION_REFUSED/);
  await assert.rejects(initializer({ auditRepository: { async appendWithClient() { throw new Error('private-detail'); },
    async verifyWithClient() {} } }).initialize(request),{ message: 'PLATFORM_AUDIT_SEGMENT_INITIALIZATION_REFUSED' });
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_audit_segments')).rows[0].count,0);
  const stale={ ...expected,inventoryDigest: 'f'.repeat(64) };
  await assert.rejects(initializer({ expected: stale }).initialize({ ...request,...stale }),/INITIALIZATION_REFUSED/);
  const results=await Promise.allSettled([initializer().initialize(request),initializer().initialize(request)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await pool.query('SELECT sequence FROM platform_audit_events WHERE segment_id=$1',[segmentId])).rows[0].sequence,'125');
  assert.deepEqual(await audit.verificationContext(),{ segmentId,verification: 'verified',
    legacy: { eventCount: 124,verification: 'unavailable' } });
  for (const name of ['cm_protected_int_customer','cm_protected_int_platform']) {
    await pool.query(`CREATE ROLE "${name}" LOGIN`);created.push(name);
  }
  await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: deploymentEpoch });
  await grantPlatformAuditSegmentRuntimeRoles(pool,{ environment: 'int',securityEpoch: deploymentEpoch,segmentId },
    { expectedOfflineRole: role,auditRepository: audit });
  // Reproduce pre069 existing-role posture without rerunning the fresh installer.
  for (const table of ['tenant_microsoft_role_settings','customer_microsoft_group_observations']) {
    await pool.query(`REVOKE ALL ON ${table} FROM cm_protected_int_customer`);
  }
  const groupScope={ environment: 'int',securityEpoch: deploymentEpoch,segmentId };
  const allowed=async(table,privilege)=>(await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
    ['cm_protected_int_customer',table,privilege])).rows[0].allowed;
  await assert.rejects(grantCustomerMicrosoftGroupRuntimeRoles(pool,groupScope,{ expectedOfflineRole: role,
    auditRepository: { async verifyWithClient() { throw new Error('private-integrity-detail'); } } }),
  { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  assert.equal(await allowed('tenant_microsoft_role_settings','SELECT'),false);
  await assert.rejects(grantCustomerMicrosoftGroupRuntimeRoles(pool,{ ...groupScope,securityEpoch: randomUUID() },
    { expectedOfflineRole: role,auditRepository: audit }),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  const granted=await grantCustomerMicrosoftGroupRuntimeRoles(pool,groupScope,{ expectedOfflineRole: role,auditRepository: audit });
  assert.equal(granted.status,'granted');
  for (const [table,privileges] of [['tenant_microsoft_role_settings',['SELECT','INSERT','UPDATE']],
    ['customer_microsoft_group_observations',['SELECT','INSERT','DELETE']]]) {
    for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
      assert.equal(await allowed(table,privilege),privileges.includes(privilege));
      assert.equal((await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
        ['cm_protected_int_platform',table,privilege])).rows[0].allowed,false);
    }
  }
  await pool.query('REVOKE ALL ON platform_microsoft_operation_proofs FROM cm_protected_int_platform');
  await assert.rejects(grantPlatformMicrosoftOperationRuntimeRoles(pool,groupScope,{ expectedOfflineRole: role,
    auditRepository: { async verifyWithClient() { throw new Error('private-integrity-detail'); } } }),
  { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  assert.equal((await pool.query("SELECT has_table_privilege('cm_protected_int_platform',"
    +"'platform_microsoft_operation_proofs','SELECT') AS allowed")).rows[0].allowed,false);
  await grantPlatformMicrosoftOperationRuntimeRoles(pool,groupScope,{ expectedOfflineRole: role,auditRepository: audit });
  for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
    assert.equal(await allowed('platform_microsoft_operation_proofs',privilege),false);
    assert.equal((await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
      ['cm_protected_int_platform','platform_microsoft_operation_proofs',privilege])).rows[0].allowed,
    ['SELECT','INSERT','UPDATE','DELETE'].includes(privilege));
  }
  const restricted={ async connect() {
    const client=await pool.connect();
    await client.query('SET SESSION AUTHORIZATION cm_protected_int_platform');
    return { query: (...args)=>client.query(...args),release: ()=>client.release(true) };
  },async query(...args) {
    const client=await restricted.connect();try { return await client.query(...args); } finally { client.release(); }
  } };
  const runtime=createPostgresPlatformAuditRepository(restricted,{ hmacSecret: 'new-test-key-'.repeat(4),
    segment: { id: segmentId,environment: 'int',deploymentEpoch } });
  assert.equal(await runtime.isReady(),true);
  const ownerExpected={ environment: 'int',deploymentEpoch,directoryId: randomUUID(),subjectId: randomUUID() };
  const ownerRequest={ ...ownerExpected,approvalReference: 'INT-OWNER-APPROVED',correlationId: randomUUID() };
  const wrong=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'wrong-test-key-'.repeat(4),
    segment: { id: segmentId,environment: 'int',deploymentEpoch } });
  const bootstrap=repository=>createPostgresPlatformOwnerBootstrapRepository(pool,
    { expected: ownerExpected,expectedOfflineRole: role,auditRepository: repository });
  await assert.rejects(bootstrap(wrong).initialize(ownerRequest),/BOOTSTRAP_REFUSED/);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_operators WHERE provider<>'demo_platform'"))
    .rows[0].count,0);
  const owner=await bootstrap(audit).initialize(ownerRequest);
  assert.equal((await pool.query("SELECT sequence FROM platform_audit_events WHERE target_type='platform_operator_bootstrap'"))
    .rows[0].sequence,'126');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_operator_change_alert_outbox WHERE operator_id=$1',
    [owner.operatorId])).rows[0].count,1);
  await assert.rejects(bootstrap(audit).initialize({ ...ownerRequest,correlationId: randomUUID() }),/BOOTSTRAP_REFUSED/);
  for (let index=0;index<30;index++) await runtime.append(anonymous());
  const checkpoint=(await pool.query('SELECT event_count,terminal_sequence FROM platform_audit_segment_checkpoints')).rows[0];
  assert.equal(Number(checkpoint.event_count),32);assert.equal(Number(checkpoint.terminal_sequence),156);
  await runtime.append(anonymous());
  const scope={ mode: 'all',operatorId,securityVersion: 1 };
  const listed=await audit.listVerified({ scope,limit: 100 });
  assert.equal(listed.length,33);assert.equal(listed.at(-1).sequence,125);
  assert.equal(listed.some(item=>item.sequence<125),false);
  for (const name of created) {
    for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
      assert.equal((await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
        [name,'platform_audit_segments',privilege])).rows[0].allowed,false);
    }
  }
  for (const [table,privilege] of [['platform_audit_chain_state','UPDATE'],['platform_audit_checkpoints','INSERT']]) {
    assert.equal((await pool.query('SELECT has_table_privilege($1,$2,$3) AS allowed',
      ['cm_protected_int_platform',table,privilege])).rows[0].allowed,false);
  }
  for (const binding of [{ id: randomUUID(),environment: 'int',deploymentEpoch },
    { id: segmentId,environment: 'int',deploymentEpoch: randomUUID() }]) {
    const foreign=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'new-test-key-'.repeat(4),segment: binding });
    assert.equal(await foreign.isReady(),false);
  }
  assert.equal(await wrong.isReady(),false);await assert.rejects(wrong.append(anonymous()),/INTEGRITY/);
  await assert.rejects(legacy.append(anonymous()),/SEGMENT_EVENT_REFUSED/);
  for (const statement of [
    'UPDATE platform_audit_chain_state SET event_count=0',
    'DELETE FROM platform_audit_events WHERE sequence=1',
    'UPDATE platform_audit_segments SET legacy_verification=legacy_verification',
    'UPDATE platform_audit_segment_heads SET event_count=event_count+1',
    'DELETE FROM platform_audit_segment_checkpoints',
    'TRUNCATE platform_audit_events CASCADE',
    'TRUNCATE platform_audit_segments CASCADE',
  ]) await assert.rejects(pool.query(statement));
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before populated segment066.
  await assert.rejects(rollbackLatest(pool),{ code: '55000' });
  assert.deepEqual(await inventory(),before);
  const retained=await pool.query(`SELECT to_jsonb(e) AS value FROM platform_audit_events e
    WHERE integrity_version=1 ORDER BY sequence`);
  assert.deepEqual(retained.rows,oldRows);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_operators')).rows[0].count,2);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_sessions')).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_passkey_credentials')).rows[0].count,0);
});
