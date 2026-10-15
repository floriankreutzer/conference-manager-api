import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApplicationCatalogContext } from '../src/application/catalog-page.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { measureCatalogRoomReads } from '../scripts/session-load-evidence.mjs';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { instrumentLoadPool, seedLoadSessions } from './support/customer-load-fixtures.js';

function roomFixture(tenantIndex, roomIndex) {
  return { id: `room-${String(roomIndex).padStart(2, '0')}`, siteId: 'site',
    name: `Synthetic site ${tenantIndex} room ${roomIndex}`, capacity: 10 + roomIndex,
    active: true, price: { amountMinor: 1000 + tenantIndex * 100 + roomIndex, currency: 'EUR' },
    equipment: ['Display', 'Whiteboard'], floorplanAssetId: null, mediaAssetIds: [] };
}

async function seedRooms(pool, tenants) {
  await pool.query(`INSERT INTO sites (tenant_id, id, name, time_zone)
    SELECT id, 'site', 'Synthetic load site', 'Europe/Berlin' FROM unnest($1::uuid[]) AS id`, [tenants]);
  const rows = tenants.flatMap((tenantId, tenantIndex) => Array.from({ length: 10 }, (_, roomIndex) => ({
    tenantId, ...roomFixture(tenantIndex, roomIndex),
  })));
  const data = JSON.stringify(rows);
  await pool.query(`INSERT INTO rooms (tenant_id, id, site_id, name, capacity, details)
    SELECT "tenantId", id, "siteId", name, capacity, jsonb_build_object('equipment', equipment)
    FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid, id text, "siteId" text,
      name text, capacity integer, equipment jsonb)`, [data]);
  await pool.query(`INSERT INTO tenant_room_prices (tenant_id, room_id, price_minor, currency, created_at, updated_at)
    SELECT "tenantId", id, (price->>'amountMinor')::bigint, price->>'currency', transaction_timestamp(), transaction_timestamp()
    FROM jsonb_to_recordset($1::jsonb) AS fixture("tenantId" uuid, id text, price jsonb)`, [data]);
  const count = await pool.query('SELECT count(*)::int AS rooms, count(DISTINCT tenant_id)::int AS tenants FROM rooms');
  assert.deepEqual(count.rows[0], { rooms: 100, tenants: 10 });
}

test('isolated PostgreSQL 18 populated room pages measure 100, 1000 and 10000 actual fixture users', async (t) => {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  assert.match(databaseUrl.pathname, /^\/conference_manager_test_[0-9]+_[0-9]+$/);
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
  await seedRooms(persistence.pool, tenants);
  // Read the real generation before measurement; never manufacture configuration authority.
  const contexts = await Promise.all(tenants.map(async (tenantId) => {
    const page = await persistence.applicationRepository.loadCatalogPage({ tenantId, section: 'sites', limit: 1 });
    assert.equal(page.status, 'ready');
    return createApplicationCatalogContext({ revisions: page.configurationRevisions,
      policyVersionId: page.bookingPolicy.policyVersionId });
  }));
  assert.equal(new Set(contexts).size, 1, 'Fixture Tenants share the same initial configuration generation');
  const fixtures = [];
  for (const target of [100, 1_000, 10_000]) {
    await seedLoadSessions(persistence.pool, tenants, fixtures, target);
    const counts = await persistence.pool.query(`SELECT count(*)::int AS users,
      count(DISTINCT tenant_id)::int AS tenants FROM users WHERE active = TRUE`);
    assert.deepEqual(counts.rows[0], { users: target, tenants: 10 });
    const continuationCursors = new Set();
    for (const pageIndex of [0, 1]) {
      const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence, close: async () => {} } });
      try {
        const address = await runtime.start();
        config.publicOrigin = `http://127.0.0.1:${address.port}`;
        const clients = await Promise.all(Array.from({ length: config.databasePoolMax }, () => persistence.pool.connect()));
        try { await Promise.all(clients.map((client) => client.query('SELECT 1'))); }
        finally { for (const client of clients) client.release(); }
        const before = readCounters();
        const pageSelector = pageIndex === 0 ? { context: contexts[0] } : { cursor: [...continuationCursors][0] };
        const result = await measureCatalogRoomReads({ origin: config.publicOrigin, ...pageSelector,
          cookies: fixtures.map((fixture) => fixture.cookie), verify(body, index) {
            const tenantIndex = tenants.indexOf(fixtures[index].tenantId);
            assert.equal(body.schemaVersion, 2);
            assert.equal(body.section, 'rooms');
            assert.equal(body.context, contexts[tenantIndex]);
            assert.deepEqual(body.entries, Array.from({ length: 5 },
              (_, roomIndex) => roomFixture(tenantIndex, pageIndex * 5 + roomIndex)));
            assert.equal(body.page.limit, 5);
            assert.equal(body.page.complete, pageIndex === 1);
            if (pageIndex === 0) {
              assert.match(body.page.nextCursor, /^[A-Za-z0-9_-]{1,2048}$/);
              continuationCursors.add(body.page.nextCursor);
            } else assert.equal(body.page.nextCursor, null);
          } });
        const after = readCounters();
        const delta = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
        assert.equal(delta.queries, target * 9, 'Session/Tenant reads plus the canonical repeatable-read page transaction');
        assert.ok(delta.bytesRead > 0 && delta.bytesWritten > 0);
        t.diagnostic(JSON.stringify({ schemaVersion: 1, environment: 'isolated-postgres18-loopback',
          workload: pageIndex === 0 ? 'populated-room-first-page' : 'populated-room-final-page', pageIndex,
          fixtureUsers: target, tenants: 10, usersPerTenant: target / 10,
          roomsPerTenant: 10, returnedRoomsPerRead: 5, nodeVersion: process.version, postgresVersion: version,
          poolMax: config.databasePoolMax, ...result, postgresProtocol: delta,
          providerEgressMeasured: false, productionCapacityProven: false, representativeActivityMixApproved: false }));
      } finally { await runtime.stop(); }
      assert.equal(continuationCursors.size, 1, 'Actual identical fixture continuations are required before the next page');
    }
  }
});
