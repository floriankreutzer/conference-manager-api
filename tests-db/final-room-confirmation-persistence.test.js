import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = '11111111-aaaa-4111-8111-111111111111';
const TENANT_B = '22222222-bbbb-4222-8222-222222222222';
const USER_A = '33333333-aaaa-4333-8333-333333333333';
const USER_B = '44444444-bbbb-4444-8444-444444444444';
const REQUEST_A1 = 'race-a-1';
const REQUEST_A2 = 'race-a-2';
const REQUEST_B = 'race-b-1';
const ROOM_ID = 'shared-room';
const SITE_ID = 'site-a';
const CHANGED_AT = new Date('2026-08-25T17:00:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
}

async function seedTenant(pool, tenantId, userId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'active'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, userId, 'Manager'],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, SITE_ID, 'Main Site'],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity) VALUES ($1, $2, $3, $4, $5)',
    [tenantId, ROOM_ID, SITE_ID, 'Shared Room', 12],
  );
}

async function seedRequest(pool, tenantId, requestId, userId) {
  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, room_id, status,
      starts_at, ends_at, internal_participants, external_participants,
      status_changed_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 4, 0, $8, $8, $8)`,
    [
      tenantId,
      requestId,
      userId,
      ROOM_ID,
      REQUEST_STATUS.IN_REVIEW,
      '2026-09-10T10:00:00.000Z',
      '2026-09-10T11:00:00.000Z',
      '2026-08-25T16:00:00.000Z',
    ],
  );
}

function repository(pool) {
  return createPostgresRequestRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        return { id: 'test-audit' };
      },
    },
  });
}

function confirm(repo, tenantId, requestId) {
  return repo.confirmIfRoomAvailable({
    tenantId,
    requestId,
    expectedStatus: REQUEST_STATUS.IN_REVIEW,
    changedAt: CHANGED_AT,
    auditEvent: { test: true },
  });
}

test('room-locked final confirmation permits exactly one overlapping winner per Tenant', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedTenant(pool, TENANT_B, USER_B);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A2, USER_A);
  await seedRequest(pool, TENANT_B, REQUEST_B, USER_B);

  const repo = repository(pool);
  const [first, second] = await Promise.all([
    confirm(repo, TENANT_A, REQUEST_A1),
    confirm(repo, TENANT_A, REQUEST_A2),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort(),
    ['confirmed', 'room_conflict'],
  );

  const tenantA = await pool.query(
    `SELECT id, status FROM requests WHERE tenant_id = $1 ORDER BY id`,
    [TENANT_A],
  );
  assert.equal(tenantA.rows.filter((row) => row.status === REQUEST_STATUS.CONFIRMED).length, 1);
  assert.equal(tenantA.rows.filter((row) => row.status === REQUEST_STATUS.IN_REVIEW).length, 1);

  const tenantB = await confirm(repo, TENANT_B, REQUEST_B);
  assert.equal(tenantB.status, 'confirmed');
  assert.equal(tenantB.request.tenantId, TENANT_B);

  const retryWinnerId = first.status === 'confirmed' ? REQUEST_A1 : REQUEST_A2;
  const retry = await confirm(repo, TENANT_A, retryWinnerId);
  assert.equal(retry.status, 'state_conflict');
  assert.equal(retry.request.status, REQUEST_STATUS.CONFIRMED);
});

test('final confirmation revalidates request state and room ownership inside the transaction', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  const repo = repository(pool);

  const wrongTenant = await confirm(repo, TENANT_B, REQUEST_A1);
  assert.equal(wrongTenant.status, 'state_conflict');
  assert.equal(wrongTenant.request, null);

  await pool.query(
    'UPDATE requests SET status = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUEST_A1, REQUEST_STATUS.CANCELLED],
  );
  const stale = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(stale.status, 'state_conflict');
  assert.equal(stale.request.status, REQUEST_STATUS.CANCELLED);
});
