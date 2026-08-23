import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresRoomAdapter } from '../src/persistence/postgres/room-adapter.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createTenantScopedRepository } from '../src/tenancy/tenant-scoped-repository.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '44444444-4444-4444-8444-444444444444';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function seedTenant(pool, tenantId, userId, siteId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${siteId}`, 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, `User ${siteId}`],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, siteId, `Site ${siteId}`],
  );
}

test('PostgreSQL migration and tenant persistence contract', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());

  await t.test('migration up is repeatable and schema readiness is versioned', async () => {
    await migrateUp(pool);
    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
    const result = await pool.query('SELECT version, name FROM schema_migrations ORDER BY version');
    assert.deepEqual(result.rows, [{ version: 1, name: 'core_tenant_schema' }]);
  });

  await t.test('tenant and room repositories isolate identical IDs across tenants', async () => {
    await seedTenant(pool, TENANT_A, USER_A, 'site-a');
    await seedTenant(pool, TENANT_B, USER_B, 'site-b');

    const rooms = createTenantScopedRepository(createPostgresRoomAdapter(pool));
    const contextA = { tenantId: TENANT_A };
    const contextB = { tenantId: TENANT_B };

    await rooms.create(contextA, {
      id: 'shared-room',
      siteId: 'site-a',
      name: 'Alpha Room',
      capacity: 10,
      active: true,
    });
    await rooms.create(contextB, {
      id: 'shared-room',
      siteId: 'site-b',
      name: 'Beta Room',
      capacity: 20,
      active: true,
    });

    assert.equal((await rooms.get(contextA, 'shared-room')).name, 'Alpha Room');
    assert.equal((await rooms.get(contextB, 'shared-room')).name, 'Beta Room');
    assert.equal(await rooms.get(contextA, 'tenant-b-only-room'), null);
    assert.equal(await rooms.update(contextB, 'alpha-only-room', { name: 'Stolen' }), null);
    assert.equal(await rooms.delete(contextB, 'alpha-only-room'), false);

    const tenantRepository = createPostgresTenantRepository(pool);
    assert.equal((await tenantRepository.findById(TENANT_A)).displayName, 'Tenant site-a');
  });

  await t.test('database constraints prevent cross-tenant and malformed references', async () => {
    await assert.rejects(
      pool.query(
        `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_A, 'cross-site', 'site-b', 'Cross Site', 5],
      ),
      (error) => error.code === '23503',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO requests
          (tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          TENANT_A,
          'cross-room-request',
          USER_A,
          'shared-room',
          'pending',
          '2026-09-01T10:00:00.000Z',
          '2026-09-01T11:00:00.000Z',
        ],
      ).then(async () => {
        await pool.query(
          'UPDATE requests SET tenant_id = $1 WHERE tenant_id = $2 AND id = $3',
          [TENANT_B, TENANT_A, 'cross-room-request'],
        );
      }),
      (error) => error.code === '23503',
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO rooms (tenant_id, id, site_id, name, capacity)
         VALUES ($1, $2, $3, $4, $5)`,
        [TENANT_A, 'bad-capacity', 'site-a', 'Bad Capacity', 0],
      ),
      (error) => error.code === '23514',
    );
  });

  await t.test('failed transactions do not leave successful writes behind', async () => {
    await assert.rejects(
      withPostgresTransaction(pool, async (client) => {
        await client.query(
          'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
          [TENANT_A, 'rolled-back-site', 'Rolled Back'],
        );
        throw new Error('EXPECTED_FAILURE');
      }),
      /EXPECTED_FAILURE/,
    );
    const result = await pool.query(
      'SELECT count(*)::int AS count FROM sites WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, 'rolled-back-site'],
    );
    assert.equal(result.rows[0].count, 0);
  });

  await t.test('rollback removes the schema and migration can be reapplied', async () => {
    assert.equal(await rollbackLatest(pool), true);
    assert.equal(await isPostgresSchemaReady(pool), false);
    await migrateUp(pool);
    assert.equal(await isPostgresSchemaReady(pool), true);
  });
});
