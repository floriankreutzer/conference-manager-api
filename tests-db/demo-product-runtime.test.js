import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { DEMO_RUNTIME_ADVISORY_LOCK } from '../src/demo/runtime-contract.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresRequestDraftWorkflowRepository } from '../src/persistence/postgres/request-draft-workflow-repository.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from '../src/persistence/postgres/calendar-authority-guard.js';
import { createPostgresDemoProductRuntimeRepository } from '../src/persistence/postgres/demo-product-runtime-repository.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp, rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';

const TENANT_KEY = 'product-runtime-tenant-test-key-at-least-32-bytes';
const PLATFORM_KEY = 'product-runtime-platform-test-key-at-least-32-bytes';
const TENANT = randomUUID(); const OWNER = randomUUID(); const OPERATOR = randomUUID();
const ROLES = Object.fromEntries(['customer', 'platform', 'reset'].map((name) => [name, `cm_product_${name}_${process.pid}`]));
const metric = (report, id) => report.product.find((item) => item.id === id);
const coverage = (report, id) => report.productCoverage.find((item) => item.id === id);

function rolePool(pool, role, connected = () => {}) {
  assert.match(role, /^[a-z][a-z0-9_]{2,62}$/);
  return {
    async connect() {
      const client = await pool.connect();
      try { await client.query(`SET ROLE "${role}"`); connected(client.processID); }
      catch (error) { client.release(error); throw error; }
      // Never return a session bearing a changed role to this test's admin pool.
      return { query: (query, values) => client.query(query, values),
        release() { client.release(new Error('DISCARD_TEST_ROLE_SESSION')); } };
    },
  };
}

async function asRole(pool, role, query, values) {
  const client = await rolePool(pool, role).connect();
  try { return await client.query(query, values); } finally { client.release(); }
}

function audit(action, requestId, occurredAt, before, after) {
  return { tenantId: TENANT, actorUserId: OWNER, action, targetType: 'request', targetId: requestId,
    previousState: before === null ? null : { status: before }, newState: { status: after },
    occurredAt: occurredAt.toISOString(), correlationId: randomUUID(), outcome: 'success', metadata: {}, retentionClass: 'business' };
}

test('Demo runtime Product reads verified existing events through minimal Ops grants and advances atomically across reset', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  const database = loadDatabaseConfig(process.env, 'test');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const databaseName = `conference_manager_demo_product_${process.pid}`;
  let pool;
  t.after(async () => {
    try {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      for (const role of Object.values(ROLES)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const productUrl = new URL(url); productUrl.pathname = `/${databaseName}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: productUrl.toString() });
  await migrateUp(pool);
  for (const role of Object.values(ROLES)) await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await pool.query("INSERT INTO tenants (id, display_name, status) VALUES ($1, 'Product fixture', 'active')", [TENANT]);
  await pool.query("INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, 'Owner')", [TENANT, OWNER]);
  await pool.query("INSERT INTO sites (tenant_id, id, name, time_zone) VALUES ($1, 'site', 'Site', 'Europe/Berlin')", [TENANT]);
  await pool.query("INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, 'room', 'site', 'Room', 10)", [TENANT]);
  const startedAt = new Date(Date.now() - 600000);
  const submittedAt = new Date(startedAt.getTime() + 120000);
  const decidedAt = new Date(submittedAt.getTime() + 60000);
  await pool.query(`INSERT INTO tenant_room_prices (tenant_id, room_id, price_minor, currency, created_at, updated_at)
    VALUES ($1, 'room', 0, 'EUR', $2, $2)`, [TENANT, startedAt]);
  const tenantAudit = createPostgresAuditRepository(pool, { hmacSecret: TENANT_KEY });
  const workflows = createPostgresRequestDraftWorkflowRepository(pool, { auditRepository: tenantAudit });
  const requests = createPostgresRequestRepository(pool, { auditRepository: tenantAudit,
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard() });
  const requestId = randomUUID();
  await workflows.startForOwner({ tenantId: TENANT, ownerUserId: OWNER, workflowId: requestId,
    idempotencyKey: randomUUID(), securityVersion: 1, changedAt: startedAt,
    auditEvent: audit('request.started', requestId, startedAt, null, 'started') });
  const from = new Date(Date.now() + 86400000).toISOString();
  const until = new Date(Date.parse(from) + 3600000).toISOString();
  const submitted = await requests.createVersionedForTenant({ tenantId: TENANT, requesterUserId: OWNER,
    requestId, workflowId: requestId, securityVersion: 1, submissionFingerprint: 'a'.repeat(64), schemaVersion: 2,
    createdAt: submittedAt, auditEvent: audit('request.created', requestId, submittedAt, null, 'Submitted'),
    requestDraft: { title: 'Product source proof', roomId: 'room', startsAt: from, endsAt: until,
      internalParticipants: 2, externalParticipants: 0, serviceIds: [],
      catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
      dietaryRequirements: null, specialRequirements: null, allocations: [],
      configurationRevisions: { organization: 1, locations: 1, catalogue: 1, bookingPolicies: 1, costAllocation: 1 } } });
  assert.equal(submitted.status, 'created');
  const decided = await requests.transitionByTenantIdAndId({ tenantId: TENANT, requestId, actorUserId: OWNER,
    actorRoleAtAction: 'conference_manager', expectedStatus: 'Submitted', expectedVersion: 1,
    nextStatus: 'Change Requested', reason: 'Fixture decision', changedAt: decidedAt,
    auditEvent: audit('request.transition', requestId, decidedAt, 'Submitted', 'Change Requested') });
  assert.equal(decided.status, 'Change Requested');
  const operatorRoles = ['platform_security_admin'];
  await pool.query(`INSERT INTO platform_operators (id, provider, provider_tenant_reference, provider_subject_reference,
    status, scope_mode, roles) VALUES ($1, 'microsoft_entra_platform', 'fixture', 'product-operator', 'active', 'all', $2)`,
  [OPERATOR, operatorRoles]);
  const platformAudit = createPostgresPlatformAuditRepository(pool, { hmacSecret: PLATFORM_KEY });
  for (let index = 0; index < 33; index += 1) {
    await platformAudit.append({ operatorId: OPERATOR, roles: operatorRoles, permissions: permissionsForPlatformRoles(operatorRoles),
      assuranceLevel: 'step_up', targetTenantId: TENANT, action: index === 0
        ? 'platform.tenant.lifecycle.changed' : 'platform.recovery.executed',
      targetType: index === 0 ? 'tenant' : 'tenant_recovery', targetId: TENANT,
      previousState: index === 0 ? { status: 'onboarding' } : null, newState: index === 0 ? { status: 'ready' } : null,
      occurredAt: new Date().toISOString(), correlationId: randomUUID(), outcome: index === 2 ? 'failure' : 'success',
      metadata: { operation: index < 3 ? 'tenant.recovery.tenant_sessions' : 'not_a_product_recovery' }, retentionClass: 'recovery' },
    { expectedTargetTenantId: TENANT });
  }
  // Existing retained evidence predates the new overlay/epoch. Installation must
  // preserve it and report its honest partial coverage instead of dropping it.
  await migrateDemoUp(pool, { roles: ROLES });
  let gatePid = null;
  const options = { pool: rolePool(pool, ROLES.platform), gatePool: rolePool(pool, ROLES.platform, (pid) => { gatePid = pid; }),
    expectedDatabaseName: databaseName, expectedRole: ROLES.platform,
    tenantAuditHmacSecret: TENANT_KEY, platformAuditHmacSecret: PLATFORM_KEY };
  const repository = createPostgresDemoProductRuntimeRepository(options);
  const original = await repository.read();
  assert.equal(metric(original, 'request_submitted').value, 1);
  assert.equal(metric(original, 'request_started').value, 1);
  assert.equal(metric(original, 'time_to_submit').value, 120000);
  assert.equal(metric(original, 'manager_decisions').value, 1);
  assert.equal(metric(original, 'manager_decision_time').value, 60000);
  assert.equal(metric(original, 'onboarding_completed').value, 1);
  assert.equal(metric(original, 'recovery_failure_rate').value, 0.5);
  assert.equal(coverage(original, 'request_submitted').state, 'partial');
  assert.equal(JSON.stringify(original).includes(requestId), false);

  await t.test('Ops can read only minimized revision facts and cannot forge or erase the epoch', async () => {
    const facts = await asRole(pool, ROLES.platform, 'SELECT * FROM demo_product_request_revision_facts LIMIT 1');
    assert.deepEqual(Object.keys(facts.rows[0]).sort(), ['actor_role_at_action', 'captured_at', 'operation',
      'request_id', 'request_status', 'request_version', 'tenant_id']);
    for (const statement of ['SELECT record FROM request_revisions', 'SELECT * FROM request_workflow_starts',
      'UPDATE demo_product_source_epoch SET source_epoch = gen_random_uuid()', 'TRUNCATE demo_product_source_epoch',
      'SELECT advance_demo_product_source_epoch()']) {
      await assert.rejects(asRole(pool, ROLES.platform, statement), (error) => error.code === '42501');
    }
    await assert.rejects(createPostgresDemoProductRuntimeRepository({ ...options, expectedRole: ROLES.customer }).read());
    await assert.rejects(createPostgresDemoProductRuntimeRepository({ ...options,
      pool: rolePool(pool, ROLES.customer), expectedRole: ROLES.customer }).read());
  });

  await t.test('source privilege or HMAC failure cannot turn a missing group into zero or hide other sources', async () => {
    await pool.query(`REVOKE SELECT ON demo_product_request_revision_facts FROM "${ROLES.platform}"`);
    try {
      const result = await repository.read();
      assert.equal(metric(result, 'request_submitted').value, 1);
      assert.equal(metric(result, 'manager_decisions').value, null);
      assert.equal(coverage(result, 'manager_decisions').reason, 'source_unavailable');
    } finally { await pool.query(`GRANT SELECT ON demo_product_request_revision_facts TO "${ROLES.platform}"`); }
    const invalidTenant = await createPostgresDemoProductRuntimeRepository({ ...options, tenantAuditHmacSecret: PLATFORM_KEY }).read();
    assert.equal(metric(invalidTenant, 'request_submitted').value, null);
    assert.equal(coverage(invalidTenant, 'request_submitted').reason, 'integrity_failure');
    assert.equal(metric(invalidTenant, 'recovery_completed').value, 1);
    const invalidPlatform = await createPostgresDemoProductRuntimeRepository({ ...options, platformAuditHmacSecret: TENANT_KEY }).read();
    assert.equal(metric(invalidPlatform, 'request_submitted').value, 1);
    assert.equal(metric(invalidPlatform, 'recovery_completed').value, null);
    await assert.rejects(createPostgresDemoProductRuntimeRepository({ ...options,
      tenantAuditHmacSecret: PLATFORM_KEY, platformAuditHmacSecret: TENANT_KEY }).read(), /PRODUCT_RUNTIME_SOURCE_UNAVAILABLE/);
  });

  await t.test('a signed checkpoint is checked independently of valid event rows', async () => {
    const before = await pool.query('SELECT checkpoint_hash FROM platform_audit_checkpoints WHERE event_count = 32');
    await pool.query('ALTER TABLE platform_audit_checkpoints DISABLE TRIGGER platform_audit_checkpoints_append_only');
    try {
      await pool.query("UPDATE platform_audit_checkpoints SET checkpoint_hash = repeat('0', 64) WHERE event_count = 32");
      const result = await repository.read();
      assert.equal(metric(result, 'request_submitted').value, 1);
      assert.equal(coverage(result, 'recovery_completed').reason, 'integrity_failure');
    } finally {
      await pool.query('UPDATE platform_audit_checkpoints SET checkpoint_hash = $1 WHERE event_count = 32',
        [before.rows[0].checkpoint_hash]);
      await pool.query('ALTER TABLE platform_audit_checkpoints ENABLE TRIGGER platform_audit_checkpoints_append_only');
    }
  });

  await t.test('a failed reset rolls back its new source epoch and the shared gate prevents mixed reads', async () => {
    const client = await pool.connect();
    try {
      const previous = await client.query('SELECT source_epoch FROM demo_product_source_epoch');
      await client.query('BEGIN');
      await client.query('TRUNCATE audit_events');
      const next = await client.query('SELECT source_epoch FROM demo_product_source_epoch');
      assert.notEqual(next.rows[0].source_epoch, previous.rows[0].source_epoch);
      await client.query('ROLLBACK');
      assert.equal((await repository.read()).provenance.sourceEpoch, original.provenance.sourceEpoch);
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]);
      gatePid = null;
      const pending = repository.read();
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const locks = await pool.query("SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted", [gatePid]);
        waiting = locks.rowCount > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      await client.query('ROLLBACK');
      assert.equal((await pending).provenance.sourceEpoch, original.provenance.sourceEpoch);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  await t.test('row limits reject truncated history while independent Platform figures survive', async () => {
    await pool.query(`INSERT INTO audit_events (tenant_id, actor_user_id, action, target_type, target_id,
      previous_state, new_state, occurred_at, correlation_id, outcome, metadata, retention_class,
      previous_hash, event_hash, integrity_version)
      SELECT tenant_id, actor_user_id, action, target_type, target_id, previous_state, new_state, occurred_at,
        correlation_id, outcome, metadata, retention_class, previous_hash,
        lpad(to_hex(generated.value + 100000), 64, '0'), integrity_version
      FROM (SELECT * FROM audit_events ORDER BY id LIMIT 1) AS sample CROSS JOIN generate_series(1, 2001) AS generated(value)`);
    const result = await repository.read();
    assert.equal(metric(result, 'request_submitted').value, null);
    assert.equal(coverage(result, 'request_submitted').reason, 'source_limit');
    assert.equal(metric(result, 'onboarding_completed').value, 1);
  });

  await t.test('real reset changes the epoch and publishes no retained pre-reset usage', async () => {
    const reset = createPostgresDemoResetRepository({ pool: rolePool(pool, ROLES.reset),
      expectedDatabaseName: databaseName, expectedResetRole: ROLES.reset });
    await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM });
    const result = await repository.read();
    assert.notEqual(result.provenance.sourceEpoch, original.provenance.sourceEpoch);
    assert.equal(metric(result, 'request_submitted').value, 0);
    assert.equal(metric(result, 'onboarding_completed').value, 0);
    assert.equal(metric(result, 'time_to_submit').value, null);
    assert.equal(coverage(result, 'request_submitted').state, 'partial');
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Enrollment grants022 before retained publication021.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Publication grants021 before source grants020.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Catalogue source grants020.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Platform passkey reset grants019 before schema053.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Unsent grants018 before schema052.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Version grants overlay017.
    assert.equal(await rollbackLatestDemoMigration(pool, { roles: ROLES }), true); // Manual grants overlay 016.
    await rollbackLatestDemoMigration(pool, { roles: ROLES }); // Catering delivery grants overlay 015.
    await rollbackLatestDemoMigration(pool, { roles: ROLES }); // Catering order grants overlay 014.
    await rollbackLatestDemoMigration(pool, { roles: ROLES }); // Catering assignment grants overlay 013.
    await rollbackLatestDemoMigration(pool, { roles: ROLES }); // Catering grants overlay 012.
    await rollbackLatestDemoMigration(pool, { roles: ROLES }); // Product-source overlay 011.
    await assert.rejects(repository.read());
    await migrateDemoUp(pool, { roles: ROLES });
    assert.equal(metric(await repository.read(), 'request_submitted').value, 0);
  });
});
