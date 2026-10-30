import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformAuditSegmentInitializer } from '../src/persistence/postgres/platform-audit-segment-initializer.js';
import { createPostgresRequestDraftWorkflowRepository } from '../src/persistence/postgres/request-draft-workflow-repository.js';
import { collectProtectedProductReport } from '../scripts/support/protected-product-collector.mjs';

const TENANT_KEY = 't'.repeat(48), PLATFORM_KEY = 'p'.repeat(48);

test('offline Product collection preserves committed starts, profile separation and verified custody', async t => {
  const pool = createPostgresPool({ mode: 'test', ...loadDatabaseConfig(process.env, 'test'), databasePoolMax: 2 });
  t.after(() => pool.end());await migrateUp(pool);
  const epoch = randomUUID(), segmentId = randomUUID(), tenant = randomUUID(), owner = randomUUID(), workflow = randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)", [epoch]);
  const role = (await pool.query('SELECT current_user AS role')).rows[0].role;
  const inventory = (await pool.query('SELECT platform_legacy_audit_inventory() AS inventory')).rows[0].inventory;
  const audit = createPostgresPlatformAuditRepository(pool, { hmacSecret: PLATFORM_KEY,
    segment: { id: segmentId, environment: 'int', deploymentEpoch: epoch } });
  const expected = { environment: 'int', segmentId, deploymentEpoch: epoch,
    legacyEventCount: Number(inventory.eventCount), inventoryDigest: inventory.digest };
  await createPostgresPlatformAuditSegmentInitializer(pool, { expected, expectedOfflineRole: role, auditRepository: audit })
    .initialize({ ...expected, approvalReference: 'QA-PRODUCT-COLLECTOR', correlationId: randomUUID() });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Collector fixture','active')", [tenant]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')", [tenant]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Owner')", [tenant, owner]);
  const tenantAudit = createPostgresAuditRepository(pool, { hmacSecret: TENANT_KEY });
  const drafts = createPostgresRequestDraftWorkflowRepository(pool, { auditRepository: tenantAudit });
  const changedAt = new Date(Date.now() - 1000);
  await drafts.startForOwner({ tenantId: tenant, ownerUserId: owner, workflowId: workflow, idempotencyKey: randomUUID(),
    securityVersion: 1, changedAt, auditEvent: { tenantId: tenant, actorUserId: owner, action: 'request.started',
      targetType: 'request', targetId: workflow, previousState: null, newState: { status: 'started' },
      occurredAt: changedAt.toISOString(), correlationId: randomUUID(), outcome: 'success', metadata: {}, retentionClass: 'business' } });
  const input = { pool, expectedOfflineRole: role, securityEpoch: epoch, dataProfile: 'real',
    tenantAuditHmacSecret: TENANT_KEY, platformAuditHmacSecret: PLATFORM_KEY };
  const report = await collectProtectedProductReport(input);
  assert.equal(report.product.find(row => row.id === 'request_started').value, 1);
  assert.equal(report.sourceContext.dataProfile, 'real');assert.equal(report.sourceContext.runtimeEnvironment, 'int');
  assert.equal(report.productCoverage.find(row => row.id === 'request_started').state, 'partial');
  for (const value of [tenant, owner, workflow, epoch, 'Collector fixture']) assert.ok(!JSON.stringify(report).includes(value));
  const synthetic = await collectProtectedProductReport({ ...input, dataProfile: 'synthetic' });
  assert.equal(synthetic.product.find(row => row.id === 'request_started').value, 0);
  assert.notEqual(synthetic.provenance.sourceEpoch, report.provenance.sourceEpoch);
  for (const change of [{ securityEpoch: randomUUID() }, { expectedOfflineRole: 'wrong_owner' },
    { platformAuditHmacSecret: 'x'.repeat(48) }, { tenantAuditHmacSecret: 'y'.repeat(48) }]) {
    await assert.rejects(() => collectProtectedProductReport({ ...input, ...change }), /PROTECTED_PRODUCT_COLLECTION_REFUSED/);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(740193,2)');
    await assert.rejects(() => collectProtectedProductReport(input), /PROTECTED_PRODUCT_COLLECTION_REFUSED/);
  } finally { await client.query('ROLLBACK');client.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM request_workflow_starts')).rows[0].count, 1);
});
