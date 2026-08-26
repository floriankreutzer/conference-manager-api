import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresMicrosoft365RoomMappingRepository,
} from '../src/persistence/postgres/microsoft365-room-mapping-repository.js';
import {
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT_A = '31313131-3131-4131-8131-313131313131';
const TENANT_B = '32323232-3232-4232-8232-323232323232';
const ADMIN_A = '33333333-3333-4333-8333-333333333333';
const ADMIN_B = '34343434-3434-4434-8434-343434343434';
const INTEGRATION_A = '35353535-3535-4535-8535-353535353535';
const INTEGRATION_B = '36363636-3636-4636-8636-363636363636';
const PROVIDER_TENANT_A = '37373737-3737-4737-8737-373737373737';
const PROVIDER_TENANT_B = '38383838-3838-4838-8838-383838383838';
const ROOM_A = '39393939-3939-4939-8939-393939393939';
const ROOM_A_DUPLICATE_ATTEMPT = '40404040-4040-4040-8040-404040404040';
const ROOM_B = '41414141-4141-4141-8141-414141414141';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const REQUEST_A = 'request-a';
const CORRELATION_A = '42424242-4242-4242-8242-424242424242';
const AUDIT_KEY = 'room-mapping-persistence-audit-key-at-least-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B];
const INITIAL_AT = new Date('2026-08-25T12:00:00.000Z');
const REFRESH_AT = new Date('2026-08-25T12:05:00.000Z');
const MISSING_AT = new Date('2026-08-25T12:10:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM microsoft365_room_mappings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query(
    "DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[]) AND provider = 'microsoft365'",
    [TENANT_IDS],
  );
  await pool.query('DELETE FROM sessions WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM user_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM tenant_identity_bindings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

async function seedTenant(pool, { tenantId, adminId, integrationId, providerTenant, siteId }) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, $3)',
    [tenantId, `Tenant ${tenantId.slice(0, 4)}`, 'onboarding'],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, adminId, `Admin ${adminId.slice(0, 4)}`],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name) VALUES ($1, $2, $3)',
    [tenantId, siteId, `Site ${siteId}`],
  );
  await pool.query({
    name: 'room-mapping-test-integration',
    text: `
      INSERT INTO integrations (
        tenant_id, id, provider, provider_reference, status,
        connection_version, last_verified_at, connection_reason,
        places_permission_status, calendars_permission_status,
        created_at, updated_at
      )
      VALUES ($1, $2, 'microsoft365', $3, 'connected', 1, $4, NULL, 'granted', 'granted', $4, $4)
    `,
    values: [tenantId, integrationId, providerTenant, INITIAL_AT],
  });
}

function providerRoom(overrides = {}) {
  return {
    externalRoomId: 'provider-room-1',
    resourceAddress: 'room-1@example.invalid',
    providerDisplayName: 'Provider Room 1',
    providerCapacity: 12,
    ...overrides,
  };
}

function auditFactory({ tenantId, actorUserId, occurredAt }) {
  return ({ roomId, operation, providerStatus }) => normalizeAuditEvent({
    tenantId,
    actorUserId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'room',
    targetId: roomId,
    previousState: null,
    newState: { providerStatus },
    occurredAt: occurredAt.toISOString(),
    correlationId: CORRELATION_A,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });
}

test('Microsoft 365 room mapping is idempotent, tenant-isolated and preserves local room authority', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const repository = createPostgresMicrosoft365RoomMappingRepository(pool, { auditRepository });

  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await clean(pool);
  await seedTenant(pool, {
    tenantId: TENANT_A,
    adminId: ADMIN_A,
    integrationId: INTEGRATION_A,
    providerTenant: PROVIDER_TENANT_A,
    siteId: SITE_A,
  });
  await seedTenant(pool, {
    tenantId: TENANT_B,
    adminId: ADMIN_B,
    integrationId: INTEGRATION_B,
    providerTenant: PROVIDER_TENANT_B,
    siteId: SITE_B,
  });

  const imported = await repository.importRooms({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    rooms: [{
      roomId: ROOM_A,
      siteId: SITE_A,
      localName: 'Local Boardroom',
      localCapacity: 10,
      ...providerRoom(),
    }],
    changedAt: INITIAL_AT,
    auditEventFor: auditFactory({ tenantId: TENANT_A, actorUserId: ADMIN_A, occurredAt: INITIAL_AT }),
  });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].roomId, ROOM_A);
  assert.deepEqual(imported[0].localRoom, {
    id: ROOM_A,
    siteId: SITE_A,
    name: 'Local Boardroom',
    capacity: 10,
    active: true,
  });

  await pool.query(
    `INSERT INTO requests (
      tenant_id, id, requester_user_id, room_id, status,
      starts_at, ends_at, internal_participants, external_participants
    ) VALUES ($1, $2, $3, $4, 'Submitted', $5, $6, 1, 0)`,
    [
      TENANT_A,
      REQUEST_A,
      ADMIN_A,
      ROOM_A,
      new Date('2026-08-26T08:00:00.000Z'),
      new Date('2026-08-26T09:00:00.000Z'),
    ],
  );

  const duplicate = await repository.importRooms({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    rooms: [{
      roomId: ROOM_A_DUPLICATE_ATTEMPT,
      siteId: SITE_A,
      localName: 'Must Not Replace Local Name',
      localCapacity: 99,
      ...providerRoom({ providerDisplayName: 'Provider Room Renamed During Import' }),
    }],
    changedAt: REFRESH_AT,
    auditEventFor: auditFactory({ tenantId: TENANT_A, actorUserId: ADMIN_A, occurredAt: REFRESH_AT }),
  });
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].roomId, ROOM_A);
  assert.equal(duplicate[0].providerDisplayName, 'Provider Room Renamed During Import');
  assert.equal(duplicate[0].localRoom.name, 'Local Boardroom');
  assert.equal(duplicate[0].localRoom.capacity, 10);
  const roomCount = await pool.query(
    'SELECT count(*)::int AS count FROM rooms WHERE tenant_id = $1',
    [TENANT_A],
  );
  assert.equal(roomCount.rows[0].count, 1);

  const refreshed = await repository.synchronize({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    discoveredRooms: [providerRoom({
      resourceAddress: 'room-renamed@example.invalid',
      providerDisplayName: 'Provider Room Renamed',
      providerCapacity: 24,
    })],
    changedAt: REFRESH_AT,
    auditEventFor: auditFactory({ tenantId: TENANT_A, actorUserId: ADMIN_A, occurredAt: REFRESH_AT }),
  });
  assert.equal(refreshed[0].providerStatus, 'active');
  assert.equal(refreshed[0].resourceAddress, 'room-renamed@example.invalid');
  assert.equal(refreshed[0].providerDisplayName, 'Provider Room Renamed');
  assert.equal(refreshed[0].providerCapacity, 24);
  assert.equal(refreshed[0].localRoom.name, 'Local Boardroom');
  assert.equal(refreshed[0].localRoom.capacity, 10);
  assert.equal(refreshed[0].localRoom.active, true);

  const missing = await repository.synchronize({
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    discoveredRooms: [],
    changedAt: MISSING_AT,
    auditEventFor: auditFactory({ tenantId: TENANT_A, actorUserId: ADMIN_A, occurredAt: MISSING_AT }),
  });
  assert.equal(missing[0].providerStatus, 'missing');
  assert.equal(missing[0].localRoom.active, true);
  const request = await pool.query(
    'SELECT room_id, status FROM requests WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUEST_A],
  );
  assert.deepEqual(request.rows[0], { room_id: ROOM_A, status: 'Submitted' });

  assert.deepEqual(
    await repository.listByTenantIdAndIntegrationId(TENANT_B, INTEGRATION_B),
    [],
  );
  const tenantB = await repository.importRooms({
    tenantId: TENANT_B,
    integrationId: INTEGRATION_B,
    rooms: [{
      roomId: ROOM_B,
      siteId: SITE_B,
      localName: 'Tenant B Room',
      localCapacity: 12,
      ...providerRoom(),
    }],
    changedAt: INITIAL_AT,
    auditEventFor: auditFactory({ tenantId: TENANT_B, actorUserId: ADMIN_B, occurredAt: INITIAL_AT }),
  });
  assert.equal(tenantB.length, 1);
  assert.equal(tenantB[0].roomId, ROOM_B);
  assert.equal((await repository.listByTenantIdAndIntegrationId(TENANT_A, INTEGRATION_A))[0].roomId, ROOM_A);

  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await rollbackLatest(pool), true);
  await assert.rejects(
    () => rollbackLatest(pool),
    /Cannot roll back Microsoft 365 room mappings while mapping rows exist/,
  );
});
