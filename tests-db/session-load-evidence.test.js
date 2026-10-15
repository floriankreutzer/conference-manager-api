import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureSessionReads } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';

test('isolated PostgreSQL 18 session reads measure 100, 1000 and 10000 actual active fixture users', async (t) => {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.match(databaseUrl.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/,
    'Only the disposable test-db runner database is accepted');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(),
    DATABASE_SSL: 'disable', RATE_LIMIT_MAX: '10000', PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    ENTRA_CLIENT_ID: randomUUID(), ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'),
    OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const persistence = createPostgresPersistence(config);
  t.after(() => persistence.close());
  const readCounters = instrumentLoadPool(persistence.pool);
  await migrateUp(persistence.pool);
  const version = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180_000 && version < 190_000);
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  await persistence.pool.query(`INSERT INTO tenants (id, display_name, status)
    SELECT id, 'Synthetic load fixture', 'active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  const fixtures = [];
  for (const target of [100, 1_000, 10_000]) {
    await seedLoadSessions(persistence.pool, tenants, fixtures, target);
    const counts = await persistence.pool.query(`SELECT count(*)::int AS users,
      count(DISTINCT tenant_id)::int AS tenants FROM users WHERE active = TRUE`);
    assert.deepEqual(counts.rows[0], { users: target, tenants: 10 });
    const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} } });
    try {
      const address = await runtime.start();
      // Bind the test configuration to its actual ephemeral port; retain exact production Host validation.
      config.publicOrigin = `http://127.0.0.1:${address.port}`;
      const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
      try { await Promise.all(clients.map((client) => client.query('SELECT 1'))); }
      finally { for (const client of clients) client.release(); }
      const before = readCounters();
      const result = await measureSessionReads({ origin: `http://127.0.0.1:${address.port}`,
        cookies: fixtures.map((fixture) => fixture.cookie),
        verify(body, index) {
          assert.equal(body.user.id, fixtures[index].userId);
          assert.equal(body.tenant.id, fixtures[index].tenantId);
          assert.equal(body.tenant.status, 'active');
          assert.deepEqual(body.roles, fixtures[index].roles);
        } });
      const after = readCounters();
      const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
      assert.equal(delta.queries, target * 2, 'One canonical session query and one Tenant query per read');
      assert.ok(delta.bytesRead > 0 && delta.bytesWritten > 0);
      t.diagnostic(JSON.stringify({ schemaVersion: 1, environment: 'isolated-postgres18-loopback',
        workload: 'session-read-only', fixtureUsers: target, tenants: 10, usersPerTenant: target / 10,
        nodeVersion: process.version, postgresVersion: version, poolMax: config.databasePoolMax,
        ...result, postgresProtocol: delta, providerEgressMeasured: false, productionCapacityProven: false }));
    } finally { await runtime.stop(); }
  }
});
