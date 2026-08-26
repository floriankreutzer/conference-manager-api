import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { REQUEST_STATUS } from '../src/domain/request-workflow.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresMicrosoft365CalendarAuthorityGuard,
} from '../src/persistence/postgres/calendar-authority-guard.js';
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
const INTEGRATION_A = '55555555-aaaa-4555-8555-555555555555';
const INTEGRATION_B = '66666666-bbbb-4666-8666-666666666666';
const BINDING_A = '77777777-aaaa-4777-8777-777777777777';
const BINDING_B = '88888888-bbbb-4888-8888-888888888888';
const PROVIDER_TENANT_A = '99999999-aaaa-4999-8999-999999999999';
const PROVIDER_TENANT_B = 'aaaaaaaa-bbbb-4aaa-8aaa-aaaaaaaaaaaa';
const RESOURCE_A = 'room-a@example.invalid';
const RESOURCE_B = 'room-b@example.invalid';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM microsoft365_room_mappings WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [[TENANT_A, TENANT_B]]);
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
  const tenantA = tenantId === TENANT_A;
  const integrationId = tenantA ? INTEGRATION_A : INTEGRATION_B;
  const bindingId = tenantA ? BINDING_A : BINDING_B;
  const providerTenantReference = tenantA ? PROVIDER_TENANT_A : PROVIDER_TENANT_B;
  await pool.query(
    `INSERT INTO tenant_identity_bindings (
       id, tenant_id, provider, provider_tenant_reference,
       claimant_provider_user_reference, status, created_at, updated_at
     ) VALUES ($1, $2, 'microsoft_entra', $3, $4, 'active', $5, $5)`,
    [bindingId, tenantId, providerTenantReference, userId, CHANGED_AT],
  );
  await pool.query(
    `INSERT INTO integrations (
       tenant_id, id, provider, provider_reference, status, connection_version,
       last_verified_at, places_permission_status, calendars_permission_status,
       created_at, updated_at
     ) VALUES ($1, $2, 'microsoft365', $3, 'connected', 1, $4, 'granted', 'granted', $4, $4)`,
    [tenantId, integrationId, providerTenantReference, CHANGED_AT],
  );
  await pool.query(
    `INSERT INTO microsoft365_room_mappings (
       tenant_id, room_id, integration_id, external_room_id, resource_address,
       provider_display_name, provider_capacity, provider_status,
       last_seen_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 12, 'active', $7, $7, $7)`,
    [
      tenantId,
      ROOM_ID,
      integrationId,
      `external-${tenantId.slice(0, 8)}`,
      tenantA ? RESOURCE_A : RESOURCE_B,
      'Shared Room',
      CHANGED_AT,
    ],
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
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });
}

function confirm(repo, tenantId, requestId, { calendarWriteEnabled = true } = {}) {
  const tenantA = tenantId === TENANT_A;
  return repo.confirmIfRoomAvailable({
    tenantId,
    requestId,
    expectedStatus: REQUEST_STATUS.IN_REVIEW,
    calendarAuthority: {
      integrationId: tenantA ? INTEGRATION_A : INTEGRATION_B,
      integrationProvider: 'microsoft365',
      identityProvider: 'microsoft_entra',
      providerConnectionReference: tenantA ? PROVIDER_TENANT_A : PROVIDER_TENANT_B,
      roomId: ROOM_ID,
      providerResourceReference: tenantA ? RESOURCE_A : RESOURCE_B,
      calendarWriteEnabled,
    },
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

test('final confirmation fails closed when the commit-time calendar authority is no longer exact', async (t) => {
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
  const repo = repository(pool);

  for (const status of ['disconnected', 'revoked']) {
    await pool.query(
      `UPDATE integrations
       SET status = $3,
           connection_version = connection_version + 1,
           last_verified_at = $4,
           updated_at = $5
       WHERE tenant_id = $1 AND id = $2`,
      [
        TENANT_A,
        INTEGRATION_A,
        status,
        status === 'disconnected' ? null : CHANGED_AT,
        CHANGED_AT,
      ],
    );
    const unavailable = await confirm(repo, TENANT_A, REQUEST_A1);
    assert.equal(unavailable.status, 'provider_authority_conflict');
    assert.equal(unavailable.request.status, REQUEST_STATUS.IN_REVIEW);
  }
  await pool.query(
    `UPDATE integrations
     SET status = 'connected', connection_version = connection_version + 1
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, INTEGRATION_A],
  );

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'unbound', updated_at = $3
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, BINDING_A, new Date('2026-08-25T17:01:00.000Z')],
  );
  const unbound = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(unbound.status, 'provider_authority_conflict');
  assert.equal(unbound.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET status = 'active', provider_tenant_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [
      TENANT_A,
      BINDING_A,
      'bbbbbbbb-aaaa-4bbb-8bbb-bbbbbbbbbbbb',
      new Date('2026-08-25T17:02:00.000Z'),
    ],
  );
  const mismatched = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(mismatched.status, 'provider_authority_conflict');
  assert.equal(mismatched.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE tenant_identity_bindings
     SET provider_tenant_reference = $3, updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, BINDING_A, PROVIDER_TENANT_A, new Date('2026-08-25T17:03:00.000Z')],
  );
  await pool.query(
    `UPDATE microsoft365_room_mappings
     SET resource_address = $4, updated_at = $5, last_seen_at = $5
     WHERE tenant_id = $1 AND room_id = $2 AND integration_id = $3`,
    [
      TENANT_A,
      ROOM_ID,
      INTEGRATION_A,
      'room-remapped@example.invalid',
      new Date('2026-08-25T17:04:00.000Z'),
    ],
  );
  const remapped = await confirm(repo, TENANT_A, REQUEST_A1);
  assert.equal(remapped.status, 'provider_authority_conflict');
  assert.equal(remapped.request.status, REQUEST_STATUS.IN_REVIEW);

  const crossTenantAuthority = await repo.confirmIfRoomAvailable({
    tenantId: TENANT_A,
    requestId: REQUEST_A1,
    expectedStatus: REQUEST_STATUS.IN_REVIEW,
    calendarAuthority: {
      integrationId: INTEGRATION_B,
      integrationProvider: 'microsoft365',
      identityProvider: 'microsoft_entra',
      providerConnectionReference: PROVIDER_TENANT_B,
      roomId: ROOM_ID,
      providerResourceReference: RESOURCE_B,
      calendarWriteEnabled: true,
    },
    changedAt: CHANGED_AT,
    auditEvent: { test: true },
  });
  assert.equal(crossTenantAuthority.status, 'provider_authority_conflict');
  assert.equal(crossTenantAuthority.request.status, REQUEST_STATUS.IN_REVIEW);

  const persisted = await pool.query(
    'SELECT status FROM requests WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUEST_A1],
  );
  assert.equal(persisted.rows[0].status, REQUEST_STATUS.IN_REVIEW);
});

test('write-disabled final confirmation cannot commit while a nonterminal calendar reference remains', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A);
  await seedRequest(pool, TENANT_A, REQUEST_A1, USER_A);
  await pool.query(
    `INSERT INTO booking_provider_references (
       tenant_id, request_id, integration_id, attempt_number, provider_reference,
       provider_connection_reference, provider_resource_reference, idempotency_key,
       state, created_correlation_id, created_at, updated_at
     ) VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, 'pending', $7, $8, $8)`,
    [
      TENANT_A,
      REQUEST_A1,
      INTEGRATION_A,
      PROVIDER_TENANT_A,
      RESOURCE_A,
      'd'.repeat(64),
      BINDING_A,
      CHANGED_AT,
    ],
  );
  const repo = repository(pool);
  const blocked = await confirm(repo, TENANT_A, REQUEST_A1, { calendarWriteEnabled: false });
  assert.equal(blocked.status, 'provider_authority_conflict');
  assert.equal(blocked.request.status, REQUEST_STATUS.IN_REVIEW);

  await pool.query(
    `UPDATE booking_provider_references
     SET provider_reference = 'event-cleaned', state = 'cancelled', updated_at = $4
     WHERE tenant_id = $1 AND request_id = $2 AND integration_id = $3`,
    [TENANT_A, REQUEST_A1, INTEGRATION_A, new Date('2026-08-25T17:05:00.000Z')],
  );
  const confirmed = await confirm(repo, TENANT_A, REQUEST_A1, { calendarWriteEnabled: false });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.request.status, REQUEST_STATUS.CONFIRMED);
});
