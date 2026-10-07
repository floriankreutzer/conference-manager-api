import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { tenantAuthorizationSnapshot, TENANT_ROLE } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createLogger } from '../src/logger.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureSessionReads } from '../scripts/session-load-evidence.mjs';

function instrument(pool) {
  const clients = new Set();
  let queries = 0;
  pool.on('connect', (client) => {
    clients.add(client);
    const query = client.query;
    client.query = function (...args) { queries += 1; return query.apply(this, args); };
  });
  return () => ({ queries, bytesRead: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesRead, 0),
    bytesWritten: [...clients].reduce((sum, c) => sum + c.connection.stream.bytesWritten, 0) });
}

async function seedSessions(pool, tenants, fixtures, target) {
  const records = [];
  const roles = Object.values(TENANT_ROLE);
  // Reuse canonical token generation/hash/security epoch without duplicating production crypto.
  // This repository captures generated fixture records; it does not simulate a provider login or its audit.
  const service = createSessionService({
    publicOrigin: 'http://127.0.0.1:3000', csrfSecret: randomBytes(32).toString('hex'),
    auditService: { createActorEvent() { return {}; }, createEvent() { return {}; }, async record() {} },
    repository: {
      async resolveByTokenHash() { throw new Error('FIXTURE_RESOLUTION_NOT_ALLOWED'); },
      async issue(record) { records.push(record); return { ...record, securityVersion: 1 }; },
    },
  });
  for (let index = fixtures.length; index < target; index += 1) {
    const identity = { tenantId: tenants[index % tenants.length], userId: randomUUID(), securityVersion: 1,
      providerIdentity: { provider: 'microsoft_entra', reference: `synthetic-${index}` },
      ...tenantAuthorizationSnapshot([roles[index % roles.length]]) };
    const result = await service.issue(identity);
    fixtures.push({ tenantId: identity.tenantId, userId: identity.userId,
      roles: identity.roles, cookie: result.setCookie.split(';', 1)[0] });
  }
  for (let offset = 0; offset < records.length; offset += 500) {
    const chunk = JSON.stringify(records.slice(offset, offset + 500));
    await pool.query(`INSERT INTO users (tenant_id, id, display_name)
      SELECT "tenantId", "userId", 'Synthetic load fixture'
      FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid, "userId" uuid)`, [chunk]);
    await pool.query(`INSERT INTO sessions (
      id, tenant_id, user_id, token_hash, provider, provider_identity_reference,
      roles, permissions, principal_version, issued_at, expires_at
    ) SELECT id, "tenantId", "userId", "tokenHash", "providerIdentity"->>'provider',
      "providerIdentity"->>'reference', ARRAY(SELECT jsonb_array_elements_text(roles)),
      ARRAY(SELECT jsonb_array_elements_text(permissions)), "expectedSecurityVersion", "issuedAt", "expiresAt"
      FROM jsonb_to_recordset($1::jsonb) AS fixture(id uuid, "tenantId" uuid, "userId" uuid,
        "tokenHash" text, "providerIdentity" jsonb, roles jsonb, permissions jsonb,
        "expectedSecurityVersion" bigint, "issuedAt" timestamptz, "expiresAt" timestamptz)`, [chunk]);
  }
}

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
  const readCounters = instrument(persistence.pool);
  await migrateUp(persistence.pool);
  const version = Number((await persistence.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 180_000 && version < 190_000);
  const tenants = Array.from({ length: 10 }, () => randomUUID());
  await persistence.pool.query(`INSERT INTO tenants (id, display_name, status)
    SELECT id, 'Synthetic load fixture', 'active' FROM unnest($1::uuid[]) AS id`, [tenants]);
  const fixtures = [];
  for (const target of [100, 1_000, 10_000]) {
    await seedSessions(persistence.pool, tenants, fixtures, target);
    const counts = await persistence.pool.query(`SELECT count(*)::int AS users,
      count(DISTINCT tenant_id)::int AS tenants FROM users WHERE active = TRUE`);
    assert.deepEqual(counts.rows[0], { users: target, tenants: 10 });
    const runtime = createCustomerComposition({ config, persistence: { ...persistence, close: async () => {} },
      logger: createLogger({ write() {} }) });
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
