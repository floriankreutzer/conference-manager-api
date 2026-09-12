import { clearSaas3TestState } from './support/saas3-test-state.js';
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
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

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
  await removeSaas2TenantAdministrationFixtures(pool, TENANTS);
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
  await clearSaas3TestState(pool);
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
  await pool.query(
    `INSERT INTO tenant_room_prices (tenant_id, room_id, price_minor, currency, created_at, updated_at)
      SELECT $1, $2, 0, default_currency, $3, $3
      FROM tenant_organization_settings WHERE tenant_id = $1`,
    [tenantId, roomId, AT],
  );
  await pool.query(
    `INSERT INTO tenant_cost_centers (
       tenant_id, id, code, name, group_name, active, created_at, updated_at
     ) VALUES
       ($1, $2, $3, $4, 'Operations', TRUE, $6, $6),
       ($1, $5, $7, 'Archived center', NULL, FALSE, $6, $6)`,
    [
      tenantId,
      `${siteId}-cost-center`,
      siteId === SITE_A ? 'COST-A' : 'COST-B',
      `Cost Center ${siteId}`,
      `${siteId}-archived`,
      AT,
      siteId === SITE_A ? 'OLD-A' : 'OLD-B',
    ],
  );
}

function requestDraft(roomId, startsAt, endsAt, internalParticipants, externalParticipants) {
  return {
    title: `Request for ${roomId}`,
    roomId,
    startsAt,
    endsAt,
    internalParticipants,
    externalParticipants,
    serviceIds: [],
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: {
      organization: 1,
      locations: 1,
      catalogue: 1,
      bookingPolicies: 1,
      costAllocation: 1,
    },
  };
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
  await pool.query(
    'UPDATE rooms SET details = $3::jsonb WHERE tenant_id = $1 AND id = $2',
    [
      TENANT_A,
      ROOM_A,
      JSON.stringify({
        equipment: ['Display', 'Whiteboard'],
        floorplanAssetId: 'floorplan-room-a',
        mediaAssetIds: ['room-a-front'],
      }),
    ],
  );

  const catalogA = await applicationRepository.loadCatalog(TENANT_A);
  assert.deepEqual(catalogA.sites.map((site) => site.id), [SITE_A]);
  assert.equal(catalogA.sites[0].timeZone, null);
  assert.deepEqual(catalogA.rooms.map((room) => room.id), [ROOM_A]);
  assert.deepEqual(catalogA.rooms[0].equipment, ['Display', 'Whiteboard']);
  assert.equal(catalogA.rooms[0].floorplanAssetId, 'floorplan-room-a');
  assert.deepEqual(catalogA.rooms[0].mediaAssetIds, ['room-a-front']);
  assert.equal(JSON.stringify(catalogA.rooms[0]).includes('serviceIds'), false);
  assert.deepEqual(catalogA.costAllocation, {
    allocationRequired: false,
    costCenters: [{
      id: `${SITE_A}-cost-center`,
      code: 'COST-A',
      name: `Cost Center ${SITE_A}`,
      group: 'Operations',
    }],
  });
  assert.equal(catalogA.bookingPolicy.policyVersionId, 'platform-default-v1');
  assert.equal(catalogA.bookingPolicy.effectiveFrom, '1970-01-01T00:00:00.000Z');
  assert.equal(catalogA.bookingPolicy.rules.maximumAdvanceMinutes, 527_040);
  assert.equal(Number.isFinite(Date.parse(catalogA.bookingPolicy.evaluatedAt)), true);
  const catalogB = await applicationRepository.loadCatalog(TENANT_B);
  assert.deepEqual(catalogB.sites.map((site) => site.id), [SITE_B]);
  assert.deepEqual(catalogB.rooms.map((room) => room.id), [ROOM_B]);
  assert.deepEqual(catalogB.costAllocation.costCenters.map((center) => center.id), [
    `${SITE_B}-cost-center`,
  ]);

  assert.deepEqual(await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_A), {
    roomActive: true,
    siteActive: true,
    timeZone: null,
  });
  assert.equal(await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_B), null);

  await pool.query(
    'UPDATE sites SET time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, SITE_A, 'Europe/Berlin'],
  );
  assert.equal(
    (await applicationRepository.findRoomBookingContext(TENANT_A, ROOM_A)).timeZone,
    'Europe/Berlin',
  );
  assert.equal((await applicationRepository.loadCatalog(TENANT_B)).sites[0].timeZone, null);

  const createdA = await requestRepository.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId: REQUEST_A,
    requesterUserId: USER_A,
    requestDraft: requestDraft(
      ROOM_A,
      '2026-09-01T10:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
      2,
      1,
    ),
    createdAt: AT,
    auditEvent: requestAudit(TENANT_A, USER_A, REQUEST_A),
  });
  assert.equal(createdA.status, 'created');
  assert.equal(createdA.request.tenantId, TENANT_A);
  assert.equal(createdA.request.requesterUserId, USER_A);
  assert.equal(createdA.request.schemaVersion, 2);
  assert.equal(createdA.request.status, 'Submitted');

  await pool.query(
    'UPDATE sites SET time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_B, SITE_B, 'Europe/London'],
  );
  await requestRepository.createVersionedForTenant({
    tenantId: TENANT_B,
    requestId: REQUEST_B,
    requesterUserId: USER_B,
    requestDraft: requestDraft(
      ROOM_B,
      '2026-09-01T12:00:00.000Z',
      '2026-09-01T13:00:00.000Z',
      1,
      0,
    ),
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
    [AUDIT_ACTION.REQUEST_CREATED, REQUEST_A],
  ]);

  await assert.rejects(
    requestRepository.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'cross-tenant-room',
      requesterUserId: USER_A,
      requestDraft: requestDraft(
        ROOM_B,
        '2026-09-02T10:00:00.000Z',
        '2026-09-02T11:00:00.000Z',
        1,
        0,
      ),
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'cross-tenant-room'),
    }),
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
  await assert.rejects(
    requestRepository.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'inactive-site-room',
      requesterUserId: USER_A,
      requestDraft: requestDraft(
        ROOM_A,
        '2026-09-03T10:00:00.000Z',
        '2026-09-03T11:00:00.000Z',
        1,
        0,
      ),
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'inactive-site-room'),
    }),
  );
  const inactiveAudit = await pool.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND target_id = 'inactive-site-room'",
    [TENANT_A],
  );
  assert.equal(inactiveAudit.rows[0].count, 0);

  await pool.query(
    'UPDATE rooms SET active = FALSE WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, ROOM_A],
  );
  const inactiveSitesPage = await applicationRepository.loadCatalogPage({
    tenantId: TENANT_A,
    section: 'sites',
    limit: 11,
  });
  const inactiveRoomsPage = await applicationRepository.loadCatalogPage({
    tenantId: TENANT_A,
    section: 'rooms',
    limit: 11,
  });
  assert.equal(inactiveSitesPage.status, 'ready');
  assert.deepEqual(inactiveSitesPage.entries, []);
  assert.equal(inactiveRoomsPage.status, 'ready');
  assert.deepEqual(inactiveRoomsPage.entries, []);
  assert.deepEqual(
    await requestRepository.findRoomContextByTenantIdAndRoomId(TENANT_A, ROOM_A),
    {
      locationsRevision: 1,
      room: {
        id: ROOM_A,
        siteId: SITE_A,
        name: `Room ${ROOM_A}`,
        capacity: 10,
        active: false,
      },
      site: {
        id: SITE_A,
        name: `Site ${SITE_A}`,
        active: false,
        timeZone: 'Europe/Berlin',
      },
    },
  );
  assert.equal(
    await requestRepository.findRoomContextByTenantIdAndRoomId(TENANT_B, ROOM_A),
    null,
  );
  const tenantBRoomsPage = await applicationRepository.loadCatalogPage({
    tenantId: TENANT_B,
    section: 'rooms',
    limit: 11,
  });
  assert.equal(tenantBRoomsPage.status, 'ready');
  assert.deepEqual(tenantBRoomsPage.entries.map((room) => room.id), [ROOM_B]);

  await pool.query(
    'UPDATE sites SET active = TRUE, time_zone = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, SITE_A, 'Mars/Olympus'],
  );
  await pool.query(
    'UPDATE rooms SET active = TRUE WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, ROOM_A],
  );
  await assert.rejects(
    requestRepository.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'invalid-time-zone-room',
      requesterUserId: USER_A,
      requestDraft: requestDraft(
        ROOM_A,
        '2026-09-04T10:00:00.000Z',
        '2026-09-04T11:00:00.000Z',
        1,
        0,
      ),
      createdAt: AT,
      auditEvent: requestAudit(TENANT_A, USER_A, 'invalid-time-zone-room'),
    }),
  );
});
