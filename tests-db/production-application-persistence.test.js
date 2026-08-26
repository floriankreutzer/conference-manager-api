import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresApplicationRepository } from '../src/persistence/postgres/application-repository.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import {
  createPostgresMicrosoft365CalendarAuthorityGuard,
} from '../src/persistence/postgres/calendar-authority-guard.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT_A = '51515151-5151-4151-8151-515151515151';
const TENANT_B = '52525252-5252-4252-8252-525252525252';
const USER_A = '53535353-5353-4353-8353-535353535353';
const USER_B = '54545454-5454-4454-8454-545454545454';
const REQUEST_A = 'request-a';
const REQUEST_B = 'request-b';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const AUDIT_KEY = 'production-application-persistence-audit-key-32';
const AT = new Date('2026-08-25T12:00:00.000Z');
const TENANTS = [TENANT_A, TENANT_B];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  await pool.query('DELETE FROM notifications WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANTS]);
}

async function seedTenant(pool, tenantId, userId, siteId, roomId) {
  await pool.query(
    'INSERT INTO tenants (id, display_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
    [tenantId, `Tenant ${siteId}`, 'active', AT],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
    [tenantId, userId, `User ${siteId}`, AT],
  );
  await pool.query(
    'INSERT INTO sites (tenant_id, id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)',
    [tenantId, siteId, `Site ${siteId}`, AT],
  );
  await pool.query(
    'INSERT INTO rooms (tenant_id, id, site_id, name, capacity, created_at, updated_at) VALUES ($1, $2, $3, $4, 10, $5, $5)',
    [tenantId, roomId, siteId, `Room ${roomId}`, AT],
  );
}

function requestAudit(tenantId, userId, requestId) {
  return normalizeAuditEvent({
    tenantId,
    actorUserId: userId,
    action: AUDIT_ACTION.REQUEST_CREATED,
    targetType: 'request',
    targetId: requestId,
    previousState: null,
    newState: { status: 'Submitted' },
    occurredAt: AT.toISOString(),
    correlationId: CORRELATION_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'request_create' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

function configurationAudit(tenantId, userId) {
  return normalizeAuditEvent({
    tenantId,
    actorUserId: userId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_configuration',
    targetId: 'sites',
    previousState: null,
    newState: { siteCount: 1 },
    occurredAt: AT.toISOString(),
    correlationId: CORRELATION_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'site_configuration_update' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });
}

test('production application persistence is tenant-scoped and request create is atomic with audit', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const applicationRepository = createPostgresApplicationRepository(pool, { auditRepository });
  const requestRepository = createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });

  t.after(async () => {
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  await clean(pool);
  await seedTenant(pool, TENANT_A, USER_A, SITE_A, ROOM_A);
  await seedTenant(pool, TENANT_B, USER_B, SITE_B, ROOM_B);

  const catalogA = await applicationRepository.loadCatalog(TENANT_A);
  assert.deepEqual(catalogA.sites.map((site) => site.id), [SITE_A]);
  assert.equal(catalogA.sites[0].timeZone, null);
  assert.deepEqual(catalogA.rooms.map((room) => room.id), [ROOM_A]);
  const catalogB = await applicationRepository.loadCatalog(TENANT_B);
  assert.deepEqual(catalogB.sites.map((site) => site.id), [SITE_B]);
  assert.deepEqual(catalogB.rooms.map((room) => room.id), [ROOM_B]);

  assert.deepEqual(await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_A), {
    roomActive: true,
    siteActive: true,
    timeZone: null,
  });
  assert.equal(await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_B), null);

  const updatedSites = await applicationRepository.updateSites({
    tenantId: TENANT_A,
    sites: [{ id: SITE_A, name: `Site ${SITE_A}`, active: true, timeZone: 'Europe/Berlin' }],
    changedAt: AT,
    auditEvent: configurationAudit(TENANT_A, USER_A),
  });
  assert.equal(updatedSites[0].timeZone, 'Europe/Berlin');
  assert.equal(
    (await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_A)).timeZone,
    'Europe/Berlin',
  );
  assert.equal((await applicationRepository.loadCatalog(TENANT_B)).sites[0].timeZone, null);

  const createdA = await requestRepository.createForTenant({
    tenantId: TENANT_A,
    requestId: REQUEST_A,
    requesterUserId: USER_A,
    roomId: ROOM_A,
    startsAt: new Date('2026-09-01T10:00:00.000Z'),
    endsAt: new Date('2026-09-01T11:00:00.000Z'),
    internalParticipants: 2,
    externalParticipants: 1,
    createdAt: AT,
    auditEvent: requestAudit(TENANT_A, USER_A, REQUEST_A),
  });
  assert.equal(createdA.tenantId, TENANT_A);
  assert.equal(createdA.requesterUserId, USER_A);
  assert.equal(createdA.status, 'Submitted');

  await pool.query(
    'UPDATE sites SET time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_B, SITE_B, 'Europe/London'],
  );
  await requestRepository.createForTenant({
    tenantId: TENANT_B,
    requestId: REQUEST_B,
    requesterUserId: USER_B,
    roomId: ROOM_B,
    startsAt: new Date('2026-09-01T12:00:00.000Z'),
    endsAt: new Date('2026-09-01T13:00:00.000Z'),
    internalParticipants: 1,
    externalParticipants: 0,
    createdAt: AT,
    auditEvent: requestAudit(TENANT_B, USER_B, REQUEST_B),
  });

  assert.deepEqual(
    (await requestRepository.listByTenantId(TENANT_A)).map((request) => request.id),
    [REQUEST_A],
  );
  assert.deepEqual(
    (await requestRepository.listByTenantId(TENANT_B)).map((request) => request.id),
    [REQUEST_B],
  );
  assert.deepEqual(
    (await requestRepository.listByTenantId(TENANT_A, { requesterUserId: USER_B })).map((request) => request.id),
    [],
  );

  const auditA = await pool.query(
    'SELECT action, target_id FROM audit_events WHERE tenant_id = $1 ORDER BY id',
    [TENANT_A],
  );
  assert.deepEqual(auditA.rows.map((row) => [row.action, row.target_id]), [
    [AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED, 'sites'],
    [AUDIT_ACTION.REQUEST_CREATED, REQUEST_A],
  ]);

  assert.equal(
    await requestRepository.createForTenant({
      tenantId: TENANT_A,
      requestId: 'cross-tenant-room',
      requesterUserId: USER_A,
      roomId: ROOM_B,
      startsAt: new Date('2026-09-02T10:00:00.000Z'),
      endsAt: new Date('2026-09-02T11:00:00.000Z'),
      internalParticipants: 1,
      externalParticipants: 0,
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'cross-tenant-room'),
    }),
    null,
  );
  const crossAudit = await pool.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND target_id = 'cross-tenant-room'",
    [TENANT_A],
  );
  assert.equal(crossAudit.rows[0].count, 0);

  await pool.query(
    'UPDATE sites SET active = FALSE WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, SITE_A],
  );
  assert.equal(
    await requestRepository.createForTenant({
      tenantId: TENANT_A,
      requestId: 'inactive-site-room',
      requesterUserId: USER_A,
      roomId: ROOM_A,
      startsAt: new Date('2026-09-03T10:00:00.000Z'),
      endsAt: new Date('2026-09-03T11:00:00.000Z'),
      internalParticipants: 1,
      externalParticipants: 0,
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'inactive-site-room'),
    }),
    null,
  );
  const inactiveAudit = await pool.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND target_id = 'inactive-site-room'",
    [TENANT_A],
  );
  assert.equal(inactiveAudit.rows[0].count, 0);

  await pool.query(
    'UPDATE sites SET active = TRUE, time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, SITE_A, 'Mars/Olympus'],
  );
  assert.equal(
    await requestRepository.createForTenant({
      tenantId: TENANT_A,
      requestId: 'invalid-time-zone-room',
      requesterUserId: USER_A,
      roomId: ROOM_A,
      startsAt: new Date('2026-09-04T10:00:00.000Z'),
      endsAt: new Date('2026-09-04T11:00:00.000Z'),
      internalParticipants: 1,
      externalParticipants: 0,
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'invalid-time-zone-room'),
    }),
    null,
  );
});
