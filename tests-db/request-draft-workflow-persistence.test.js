import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { normalizeAuditEvent } from '../src/audit/event.js';
import { toPublicRequest } from '../src/domain/request.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from '../src/persistence/postgres/calendar-authority-guard.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { createPostgresRequestDraftWorkflowRepository } from '../src/persistence/postgres/request-draft-workflow-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const AT = new Date('2026-10-18T09:00:00.000Z');
const END = new Date('2026-10-18T09:02:00.000Z');
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();
const OWNER = randomUUID();
const COLLEAGUE = randomUUID();
const OTHER_OWNER = randomUUID();

function audit(tenantId, ownerUserId, workflowId, action, occurredAt = AT) {
  return normalizeAuditEvent({ tenantId, actorUserId: ownerUserId, action,
    targetType: 'request', targetId: workflowId, previousState: null,
    newState: { status: action === 'request.created' ? 'Submitted'
      : action === 'request.abandoned' ? 'abandoned' : 'started' },
    occurredAt: occurredAt.toISOString(), correlationId: randomUUID(), outcome: 'success',
    metadata: { operation: 'workflow_test' }, retentionClass: 'business' });
}

function startValues(overrides = {}) {
  const values = { tenantId: TENANT, ownerUserId: OWNER, workflowId: randomUUID(),
    idempotencyKey: randomUUID(), securityVersion: 1, changedAt: AT, ...overrides };
  return { ...values, auditEvent: audit(values.tenantId, values.ownerUserId, values.workflowId, 'request.started') };
}

function submission(values, overrides = {}) {
  return { tenantId: values.tenantId, requesterUserId: values.ownerUserId,
    requestId: values.workflowId, workflowId: values.workflowId, securityVersion: 1,
    submissionFingerprint: 'a'.repeat(64), schemaVersion: 2, createdAt: END,
    auditEvent: audit(values.tenantId, values.ownerUserId, values.workflowId, 'request.created', END),
    requestDraft: { title: 'Submission fixture', roomId: 'room',
      startsAt: '2026-10-19T10:00:00.000Z', endsAt: '2026-10-19T11:00:00.000Z',
      internalParticipants: 2, externalParticipants: 0, serviceIds: [],
      catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
      dietaryRequirements: null, specialRequirements: null, allocations: [],
      configurationRevisions: { organization: 1, locations: 1, catalogue: 1, bookingPolicies: 1, costAllocation: 1 } },
    ...overrides };
}

test('Request lifecycle is tenant/owner scoped, concurrent, idempotent and audit-atomic in PostgreSQL', async (t) => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.match(url.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
  const pool = createPostgresPool({ mode: 'test', ...loadDatabaseConfig(process.env, 'test') });
  t.after(() => pool.end());
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'workflow-local-test-key-32-characters' });
  const workflows = createPostgresRequestDraftWorkflowRepository(pool, { auditRepository });
  const requests = createPostgresRequestRepository(pool, { auditRepository,
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard() });
  await pool.query(`INSERT INTO tenants (id, display_name, status)
    VALUES ($1, 'Fixture A', 'active'), ($2, 'Fixture B', 'active')`, [TENANT, OTHER_TENANT]);
  await pool.query(`INSERT INTO users (tenant_id, id, display_name)
    VALUES ($1, $2, 'Owner'), ($1, $3, 'Colleague'), ($4, $5, 'Foreign owner')`,
    [TENANT, OWNER, COLLEAGUE, OTHER_TENANT, OTHER_OWNER]);
  await pool.query("INSERT INTO sites (tenant_id, id, name, time_zone) VALUES ($1, 'site', 'Site', 'Europe/Berlin')", [TENANT]);
  await pool.query("INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, 'room', 'site', 'Room', 10)", [TENANT]);
  await pool.query(`INSERT INTO tenant_room_prices
    (tenant_id, room_id, price_minor, currency, created_at, updated_at)
    VALUES ($1, 'room', 0, 'EUR', $2, $2)`, [TENANT, AT]);

  const original = startValues();
  const starts = await Promise.all(Array.from({ length: 8 }, () => workflows.startForOwner(
    startValues({ idempotencyKey: original.idempotencyKey }),
  )));
  const id = starts[0].workflow.id;
  assert.equal(new Set(starts.map((result) => result.workflow.id)).size, 1);
  assert.equal(starts.filter((result) => result.status === 'started').length, 1);
  const owned = startValues({ workflowId: id, idempotencyKey: original.idempotencyKey });
  const abandon = { ...owned, changedAt: END, auditEvent: audit(TENANT, OWNER, id, 'request.abandoned', END) };

  await t.test('foreign owners/tenants, stale sessions and suspended tenants cannot mutate the workflow', async () => {
    for (const changed of [{ ownerUserId: COLLEAGUE },
      { tenantId: OTHER_TENANT, ownerUserId: OTHER_OWNER }, { securityVersion: 2 }]) {
      assert.equal((await workflows.abandonForOwner({ ...abandon, ...changed })).status, 'not_found');
      assert.equal((await requests.createVersionedForTenant(submission(owned, {
        ...(changed.ownerUserId ? { requesterUserId: changed.ownerUserId } : {}),
        ...(changed.tenantId ? { tenantId: changed.tenantId } : {}),
        ...(changed.securityVersion ? { securityVersion: changed.securityVersion } : {}),
      }))).status, 'not_found');
    }
    await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [TENANT]);
    assert.equal((await workflows.startForOwner(startValues())).status, 'not_found');
    assert.equal((await workflows.abandonForOwner(abandon)).status, 'not_found');
    await pool.query("UPDATE tenants SET status = 'active' WHERE id = $1", [TENANT]);
    await pool.query('UPDATE users SET active = FALSE WHERE tenant_id = $1 AND id = $2', [TENANT, OWNER]);
    assert.equal((await workflows.startForOwner(startValues())).status, 'not_found');
    await pool.query('UPDATE users SET active = TRUE WHERE tenant_id = $1 AND id = $2', [TENANT, OWNER]);
  });

  await t.test('idempotency keys are scoped to both tenant and owner', async () => {
    const colleague = await workflows.startForOwner(startValues({ ownerUserId: COLLEAGUE, idempotencyKey: original.idempotencyKey }));
    const foreign = await workflows.startForOwner(startValues({
      tenantId: OTHER_TENANT, ownerUserId: OTHER_OWNER, idempotencyKey: original.idempotencyKey,
    }));
    assert.equal(new Set([id, colleague.workflow.id, foreign.workflow.id]).size, 3);
  });

  await t.test('only one explicit abandonment is recorded and abandoned workflows cannot submit', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => workflows.abandonForOwner(abandon)));
    assert.equal(results.filter((result) => result.status === 'abandoned').length, 1);
    assert.ok(results.every((result) => result.workflow.status === 'abandoned'));
    assert.equal((await requests.createVersionedForTenant(submission(owned))).status, 'workflow_conflict');
    const rows = await pool.query('SELECT action FROM audit_events WHERE tenant_id = $1 AND target_id = $2 ORDER BY id', [TENANT, id]);
    assert.deepEqual(rows.rows.map((row) => row.action), ['request.started', 'request.abandoned']);
  });

  await t.test('first submission and exact retries share a Request and immutable first revision', async () => {
    const values = startValues();
    await workflows.startForOwner(values);
    const results = await Promise.all([
      requests.createVersionedForTenant(submission(values)), requests.createVersionedForTenant(submission(values)),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['created', 'replayed']);
    const created = results.find((result) => result.status === 'created').request;
    const replayed = results.find((result) => result.status === 'replayed').publicRequest;
    assert.deepEqual(toPublicRequest(created), replayed);
    assert.equal(created.id, values.workflowId);
    const later = await requests.createVersionedForTenant(submission(values, { createdAt: new Date(END.getTime() + 60_000) }));
    assert.deepEqual(later.publicRequest, toPublicRequest(created));
    const changed = await requests.createVersionedForTenant(submission(values, { submissionFingerprint: 'b'.repeat(64) }));
    assert.equal(changed.status, 'workflow_conflict');
    assert.equal((await workflows.abandonForOwner({ ...values, changedAt: END })).status, 'conflict');
    const events = await pool.query('SELECT action FROM audit_events WHERE tenant_id = $1 AND target_id = $2 ORDER BY id',
      [TENANT, values.workflowId]);
    assert.deepEqual(events.rows.map((row) => row.action), ['request.started', 'request.created']);
    const revisions = await pool.query(
      'SELECT count(*)::integer AS count FROM request_revisions WHERE tenant_id = $1 AND request_id = $2',
      [TENANT, values.workflowId],
    );
    assert.equal(revisions.rows[0].count, 1);
  });

  await t.test('audit failure rolls back both a new start and an attempted submission', async () => {
    const failingAudit = { async appendWithClient() { throw new Error('INJECTED_AUDIT_FAILURE'); } };
    const failingWorkflows = createPostgresRequestDraftWorkflowRepository(pool, { auditRepository: failingAudit });
    const values = startValues();
    await assert.rejects(failingWorkflows.startForOwner(values), /INJECTED_AUDIT_FAILURE/);
    assert.equal((await pool.query('SELECT 1 FROM request_workflow_starts WHERE tenant_id = $1 AND id = $2',
      [TENANT, values.workflowId])).rowCount, 0);
    await workflows.startForOwner(values);
    const failingRequests = createPostgresRequestRepository(pool, { auditRepository: failingAudit,
      calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard() });
    await assert.rejects(failingRequests.createVersionedForTenant(submission(values)), /INJECTED_AUDIT_FAILURE/);
    assert.equal((await pool.query('SELECT 1 FROM requests WHERE tenant_id = $1 AND id = $2', [TENANT, values.workflowId])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM request_revisions WHERE tenant_id = $1 AND request_id = $2',
      [TENANT, values.workflowId])).rowCount, 0);
    assert.equal((await pool.query('SELECT status FROM request_workflow_starts WHERE tenant_id = $1 AND id = $2',
      [TENANT, values.workflowId])).rows[0].status, 'started');
    await assert.rejects(failingWorkflows.abandonForOwner({ ...values, changedAt: END }), /INJECTED_AUDIT_FAILURE/);
    assert.equal((await pool.query('SELECT status FROM request_workflow_starts WHERE tenant_id = $1 AND id = $2',
      [TENANT, values.workflowId])).rows[0].status, 'started');
  });

  await t.test('database constraints preserve ownership, clock and terminal state; rollback protects history', async () => {
    for (const sql of [
      "UPDATE request_workflow_starts SET started_at = started_at - interval '1 minute' WHERE tenant_id = $1 AND id = $2",
      "UPDATE request_workflow_starts SET status = 'started', ended_at = NULL WHERE tenant_id = $1 AND id = $2",
      `UPDATE request_workflow_starts SET owner_user_id = '${COLLEAGUE}' WHERE tenant_id = $1 AND id = $2`,
    ]) await assert.rejects(pool.query(sql, [TENANT, id]), (error) => error.code === '23514');
    assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
    assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
    assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
    assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
    assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
    assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
    assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
    assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
    assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
    assert.equal(await rollbackLatest(pool), true); // Empty manual delivery schema 050.
    assert.equal(await rollbackLatest(pool), true); // Empty Catering delivery schema 049.
    assert.equal(await rollbackLatest(pool), true); // Empty Catering order schema 048.
    assert.equal(await rollbackLatest(pool), true); // Empty Catering assignment schema 047.
    assert.equal(await rollbackLatest(pool), true); // Empty Catering configuration schema 046.
    await assert.rejects(rollbackLatest(pool), /REQUEST_WORKFLOW_ROLLBACK_REQUIRES_EMPTY_HISTORY/);
    assert.equal(await isPostgresSchemaReady(pool), false);
    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
  });
  assert.equal(await auditRepository.verifyTenantChain(TENANT), true);
  assert.equal(await auditRepository.verifyTenantChain(OTHER_TENANT), true);
});
