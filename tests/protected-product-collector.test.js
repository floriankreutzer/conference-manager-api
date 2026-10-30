import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadMigrations } from '../scripts/db-migrations.mjs';
import { collectProtectedProductReport } from '../scripts/support/protected-product-collector.mjs';
import { createSegmentSigners } from '../src/persistence/postgres/platform-audit-integrity.js';
import { normalizePlatformAuditEvent } from '../src/platform/audit/event.js';

async function fixture() {
  const epoch = randomUUID(), segmentId = randomUUID(), now = new Date('2026-10-30T12:00:00.000Z');
  const segment = { id: segmentId, environment: 'int', deploymentEpoch: epoch, legacyEventCount: 0,
    inventoryDigest: 'a'.repeat(64), approvalReference: 'QA-PRODUCT' };
  const event = normalizePlatformAuditEvent({ operatorId: null, roles: [], permissions: [], assuranceLevel: 'offline_owner',
    targetTenantId: null, action: 'platform.operator.changed', targetType: 'platform_audit_segment', targetId: segmentId,
    previousState: null, newState: null, occurredAt: now.toISOString(), correlationId: randomUUID(), outcome: 'success',
    retentionClass: 'recovery', metadata: { operation: 'audit_segment_genesis', environment: 'int', deploymentEpoch: epoch,
      inventoryDigest: segment.inventoryDigest, approvalReference: segment.approvalReference, legacyVerification: 'unavailable' } });
  const genesis = { sequence: 1, segment_id: segmentId, segment_sequence: 1, integrity_version: 2,
    operator_id: event.operatorId, roles: event.roles, permissions: event.permissions, assurance_level: event.assuranceLevel,
    target_tenant_id: null, action: event.action, target_type: event.targetType, target_id: event.targetId,
    previous_state: null, new_state: null, occurred_at: now, correlation_id: event.correlationId, outcome: event.outcome,
    metadata: event.metadata, retention_class: event.retentionClass, previous_hash: null,
    event_hash: createSegmentSigners('p'.repeat(48), segment).event(event, 1, null) };
  const migrations = await loadMigrations(), calls = [];let mutate = (_sql, rows) => rows,leaseHeld=false,snapshotHadLease=false;
  const makePool=prefix=>({ async query() { throw new Error('DIRECT_POOL_QUERY_FORBIDDEN'); },async connect() { return { async query(sql) {
    const text = typeof sql === 'string' ? sql : sql.text;calls.push(prefix+text);let rows = [];
    if (!prefix && text==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') snapshotHadLease=leaseHeld;
    if (text.includes('AS locked')) rows = [{ locked: true }];
    else if (text.includes('AS acquired')) rows = [{ acquired: true }];
    else if (text.includes('FROM protected_runtime_deployments WHERE')) rows = [{ security_epoch: epoch }];
    else if (text.includes('AS owner_role')) rows = [{ active_role: 'migration_owner',
      authenticated_role: 'migration_owner', owner_role: 'migration_owner' }];
    else if (text.includes('FROM schema_migrations')) rows = migrations;
    else if (text.includes('AS epoch_started_at')) rows = [{ created_at: now, epoch_started_at: now, observed_at: now }];
    else if (text.includes('FROM platform_audit_segments s')) rows = [{ id: segmentId, legacy_event_count: 0,
      inventory_digest: segment.inventoryDigest, approval_reference: segment.approvalReference, created_at: now,
      event_count: 1, terminal_event_hash: genesis.event_hash, terminal_checkpoint_hash: null }];
    else if (text.includes('FROM platform_audit_events WHERE')) rows = [genesis];
    rows=mutate(text,structuredClone(rows));
    if (prefix && text.includes('AS acquired')) leaseHeld=rows[0]?.acquired===true;
    if (prefix && ['COMMIT','ROLLBACK'].includes(text)) leaseHeld=false;
    return { rows,rowCount: rows.length };
  }, release() { calls.push(prefix+'RELEASE'); } }; } });
  const pool=makePool(''),leasePool=makePool('LEASE ');
  return { calls,snapshotHadLease: ()=>snapshotHadLease,mutate: fn => { mutate = fn; },
    input: { pool,leasePool,expectedOfflineRole: 'migration_owner', securityEpoch: epoch,
    dataProfile: 'synthetic', tenantAuditHmacSecret: 't'.repeat(48), platformAuditHmacSecret: 'p'.repeat(48) } };
}

test('collector publishes minimized verified aggregates only from one bounded read-only epoch snapshot', async () => {
  const f = await fixture(), report = await collectProtectedProductReport(f.input);
  assert.equal(report.sourceContext.dataProfile, 'synthetic');
  assert.equal(report.product.find(row => row.id === 'request_started').value, 0);
  assert.equal(report.product.find(row => row.id === 'time_to_submit').value, null);
  assert.equal(report.product.find(row => row.id === 'time_to_submit').reason, 'empty_denominator');
  assert.ok(f.calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(f.calls.includes('COMMIT'));assert.ok(f.calls.includes('RELEASE'));assert.equal(f.calls.at(-1), 'LEASE RELEASE');
  assert.ok(!f.calls.some(sql => /^(?:LEASE )?(INSERT|UPDATE|DELETE|GRANT|TRUNCATE)\b/.test(sql)));
  assert.ok(!JSON.stringify(report).includes(f.input.securityEpoch));
});

test('the current-epoch lease is held before the Product read-only snapshot begins',async()=>{
  const f=await fixture();await collectProtectedProductReport(f.input);
  assert.equal(f.snapshotHadLease(),true);
  assert.ok(f.calls.indexOf('RELEASE')<f.calls.indexOf('LEASE RELEASE'));
});

test('Product collection rejects missing or shared lease pools before database work',async()=>{
  for (const invalid of [undefined,null,{},'same']) {
    const f=await fixture();
    await assert.rejects(()=>collectProtectedProductReport({ ...f.input,leasePool: invalid==='same' ? f.input.pool : invalid }),
      { message: 'PROTECTED_PRODUCT_COLLECTION_REFUSED' });
    assert.deepEqual(f.calls,[]);
  }
});

test('missing epoch, unexpected owner, ledger drift, tampering and over-limit sources fail without a partial report', async () => {
  const modifications = [
    (sql, rows) => sql.includes('AS locked') || sql.includes('AS acquired') ? [{ locked: false,acquired: false }] : rows,
    (sql, rows) => sql.includes('AS epoch_started_at') ? [] : rows,
    (sql, rows) => sql.includes('AS owner_role') ? [{ ...rows[0], authenticated_role: 'foreign' }] : rows,
    (sql, rows) => sql.includes('FROM schema_migrations') ? rows.slice(1) : rows,
    (sql, rows) => sql.includes('FROM platform_audit_events WHERE') ? [{ ...rows[0], event_hash: 'f'.repeat(64) }] : rows,
    (sql, rows) => sql.includes('FROM platform_audit_segments s') ? [{ ...rows[0], event_count: 2001 }] : rows,
    (sql, rows) => sql.includes('FROM tenant_runtime_registry') ? Array.from({ length: 101 }, () => ({})) : rows,
  ];
  for (const change of modifications) {
    const f = await fixture();f.mutate(change);
    await assert.rejects(() => collectProtectedProductReport(f.input), { message: 'PROTECTED_PRODUCT_COLLECTION_REFUSED' });
    assert.ok(f.calls.some(sql=>/^(?:LEASE )?ROLLBACK$/.test(sql)));assert.equal(f.calls.at(-1), 'LEASE RELEASE');
  }
});

test('collector CLI refuses arguments and unsafe output custody before database allocation without exposing input', () => {
  const result = spawnSync(process.execPath, ['scripts/collect-protected-product.mjs', 'private-canary'], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 5000,
  });
  assert.equal(result.status, 1);assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'PROTECTED_PRODUCT_COLLECTION_REFUSED\n');
});
