import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringJobRuntime } from '../src/catering-job-composition.js';
import { loadConfig } from '../src/config.js';
import { createMetricsRegistry } from '../src/observability/metrics.js';
import { createAuditHarness } from './support/audit-harness.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';

const enabled = () => loadConfig({ NODE_ENV: 'test', CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
function fixture(ready) {
  const audit = createAuditHarness(); let queries = 0;
  const pool = { async query() { queries++; throw new Error('UNEXPECTED_DIRECT_QUERY'); },
    async connect() { return { async query(statement) {
      queries++; if (typeof statement === 'string' && statement.includes('FROM tenants tenant')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    }, release() {} }; } };
  const metrics = createMetricsRegistry();
  const persistence = { pool, readinessChecks: [async () => ready], auditRepository: { async appendWithClient() {
    throw new Error('UNEXPECTED_AUDIT');
  } } };
  return { audit, metrics, persistence, queries: () => queries };
}

test('disabled job runtime creates no timer, database access or provider fallback', () => {
  const forbidden = new Proxy({}, { get() { throw new Error('DISABLED_DEPENDENCY_ACCESSED'); } });
  assert.equal(createCateringJobRuntime({ config: {}, persistence: forbidden, metrics: forbidden, logger: forbidden }), null);
  assert.throws(() => createCateringJobRuntime({ config: { ...enabled(), demoRuntime: true } }), /DEMO_NOT_SUPPORTED/);
  assert.throws(() => createCateringJobRuntime({ config: enabled(), persistence: { pool: {} } }), /READINESS_REQUIRED/);
});

test('job admission evaluates readiness before durable SQL and returns only real bounded batch results', async () => {
  for (const ready of [false,true]) {
    const f = fixture(ready);
    const worker = createCateringJobRuntime({ config: enabled(), persistence: f.persistence, auditService: f.audit.service,
      metrics: f.metrics, logger: { lifecycle() {} } });
    try {
      if (ready) assert.deepEqual(await worker.runOnce(), {
        completedCount: 0, deferredCount: 0, reconciliationCount: 0, failedCount: 0,
      });
      else await assert.rejects(worker.runOnce(), /INTEGRATION_JOB_BATCH_UNAVAILABLE/);
      assert.equal(f.queries() > 0, ready);
    } finally { await worker.stop(); }
  }
});

test('job metric labels contain only fixed aggregate outcomes and reject private dimensions before emission', () => {
  const metrics = createMetricsRegistry();
  metrics.recordIntegrationJobBatch({ completedCount: 1, deferredCount: 2, reconciliationCount: 3, failedCount: 4 });
  metrics.recordIntegrationJobBatchFailure();
  assert.equal(metrics.snapshot().counters.length, 5);
  assert.equal(metrics.snapshot().counters.reduce((sum, counter) => sum + counter.value, 0), 11);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /tenant|orderId|jobId|providerPayload/);
  for (const value of [{ completedCount: 26, deferredCount: 0, reconciliationCount: 0, failedCount: 0 },
    { completedCount: 1, deferredCount: 0, reconciliationCount: 0, failedCount: 0, tenantId: 'foreign' },
    { completedCount: 1, deferredCount: -1, reconciliationCount: 0, failedCount: 0 },
    { completedCount: 20, deferredCount: 20, reconciliationCount: 0, failedCount: 0 }]) {
    assert.throws(() => metrics.recordIntegrationJobBatch(value), /METRIC_JOB_BATCH_INVALID/);
  }
  assert.equal(metrics.snapshot().counters.length, 5);
});

test('enabled real Customer composition constructs with the required calendar port without making provider calls', async () => {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost:1/synthetic', DATABASE_SSL: 'disable',
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true', AUDIT_HMAC_SECRET: 'a'.repeat(32),
    CSRF_SECRET: 'c'.repeat(32), OIDC_TRANSACTION_SECRET: 'o'.repeat(32),
    ENTRA_CLIENT_ID: 'e0000000-0000-4000-8000-000000000001', ENTRA_CLIENT_SECRET: 'e'.repeat(32) });
  const persistence = createPostgresPersistence(config);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('SYNTHETIC_PROVIDER_OPERATION_FORBIDDEN'); };
  const microsoft365Client = Object.fromEntries(['lookupFreeBusy','adminConsentUrl','verifyBasePermissions','discoverRooms']
    .map((method) => [method, forbidden]));
  let runtime;
  try {
    runtime = createCustomerComposition({ config, persistence, microsoft365Client, logger: { lifecycle() {} } });
    assert.equal(typeof runtime.start, 'function'); assert.equal(calls, 0);
  } finally { if (runtime) await runtime.stop(); else await persistence.close(); }
});
