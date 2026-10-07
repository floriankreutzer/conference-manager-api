import assert from 'node:assert/strict';
import test from 'node:test';
import { createHealthMonitor } from '../src/observability/health.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createPostgresPlatformPersistence } from '../src/persistence/postgres/platform-index.js';
import { CURRENT_SCHEMA_VERSION } from '../src/persistence/postgres/pool.js';

const CONFIG = Object.freeze({
  mode: 'test',
  databaseUrl: 'postgresql://unused:unused@127.0.0.1/unused',
  databaseSsl: 'disable',
  databasePoolMax: 1,
  databaseConnectionTimeoutMs: 500,
  databaseIdleTimeoutMs: 1_000,
  databaseStatementTimeoutMs: 500,
  auditHmacSecret: 'readiness-test-audit-key-0000000001',
  tenantAuditHmacSecret: 'readiness-test-tenant-audit-key-002',
  cursorSecret: 'readiness-test-cursor-key-00000003',
});

for (const [surface, factory] of [
  ['Customer', createPostgresPersistence],
  ['Platform', createPostgresPlatformPersistence],
]) {
  test(`${surface} readiness uses one database roundtrip without stale healthy caching`, async (t) => {
    const persistence = factory(CONFIG);
    t.after(() => persistence.close());
    let queryCount = 0;
    let outcome = CURRENT_SCHEMA_VERSION;
    persistence.pool.query = async (query) => {
      queryCount += 1;
      assert.equal(query.name, 'schema-readiness');
      if (outcome === 'failure') throw new Error('private-driver-error');
      if (outcome === 'timeout') return new Promise(() => {});
      return { rows: [{ version: outcome }] };
    };
    const monitor = createHealthMonitor({ readinessChecks: persistence.readinessChecks, timeoutMs: 5 });
    for (const [version, ready] of [
      [CURRENT_SCHEMA_VERSION, true],
      [CURRENT_SCHEMA_VERSION - 1, false],
      [CURRENT_SCHEMA_VERSION + 1, false],
      [null, false],
      ['failure', false],
      ['timeout', false],
      [CURRENT_SCHEMA_VERSION, true],
    ]) {
      outcome = version;
      const before = queryCount;
      const status = await monitor.evaluate();
      assert.equal(status.ready, ready);
      assert.equal(queryCount - before, 1);
      assert.doesNotMatch(JSON.stringify(status), /private-driver-error|postgresql|unused/);
    }
  });
}
