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
  const configuration={ mode: 'test', ...loadDatabaseConfig(process.env, 'test'), databasePoolMax: 1 };
  const pool=createPostgresPool(configuration),leasePool=createPostgresPool(configuration),control=createPostgresPool(configuration);
  t.after(()=>Promise.all([pool.end(),leasePool.end(),control.end()]));await migrateUp(pool);
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
  const input = { pool,leasePool,expectedOfflineRole: role, securityEpoch: epoch, dataProfile: 'real',
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
  let pending=true,rotated=null;
  const instrumented={ query: (...args)=>pool.query(...args),async connect() {
    const reader=await pool.connect();
    return { async query(statement,...args) {
      const result=await reader.query(statement,...args);
      if (pending && typeof statement==='string' && statement.startsWith('SELECT set_config')) {
        pending=false;
        // The first SELECT fixes the real RR snapshot. An independent reset
        // must already be excluded, rather than commit before a later lock.
        const reset=await control.connect();let committed=false;
        try {
          await reset.query('BEGIN');
          rotated=(await reset.query('SELECT pg_try_advisory_xact_lock(740193,2) AS acquired')).rows[0].acquired;
          if (rotated) await reset.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,
            revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]);
          await reset.query('COMMIT');committed=true;
        } finally { if (!committed) await reset.query('ROLLBACK');reset.release(); }
      }
      return result;
    },release: error=>reader.release(error) };
  } };
  const fenced=await collectProtectedProductReport({ ...input,pool: instrumented });
  assert.equal(pending,false);assert.equal(rotated,false);
  assert.equal(fenced.product.find(row=>row.id==='request_started').value,1);
  const current=(await pool.query("SELECT security_epoch FROM protected_runtime_deployments WHERE environment='int'")).rows[0];
  assert.equal(current.security_epoch,epoch);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM request_workflow_starts')).rows[0].count, 1);
});
