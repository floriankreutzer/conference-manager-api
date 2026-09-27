import { clearSaas3TestState } from './support/saas3-test-state.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresBookingChangeRepository,
} from '../src/persistence/postgres/booking-change-repository.js';
import {
  createPostgresMicrosoft365RoomMappingRepository,
} from '../src/persistence/postgres/microsoft365-room-mapping-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import {
  createPostgresTenantLocationRepository,
} from '../src/persistence/postgres/tenant-location-repository.js';
import { createHttpServer } from '../src/server.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '61616161-6161-4161-8161-616161616161';
const TENANT_B = '62626262-6262-4262-8262-626262626262';
const ADMIN_A = '63636363-6363-4363-8363-636363636363';
const ADMIN_B = '64646464-6464-4464-8464-646464646464';
const INTEGRATION_A = '65656565-6565-4565-8565-656565656565';
const PROVIDER_TENANT_A = '66666666-6666-4666-8666-666666666666';
const SESSION_A = '67676767-6767-4767-8767-676767676767';
const CORRELATION_A = '68686868-6868-4868-8868-686868686868';
const CORRELATION_B = '69696969-6969-4969-8969-696969696969';
const AUDIT_SECRET = 'tenant-location-test-audit-key-at-least-32-bytes';
const TENANT_IDS = [TENANT_A, TENANT_B];
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const ROOM_A = 'room-a';
const ROOM_B = 'room-b';
const IMPORTED_ROOM = 'room-imported';
const BOOKING_CHANGE_ID = '70707070-7070-4070-8070-707070707070';
const BOOKING_CHANGE_REQUEST = 'booking-change-location-race';
const CSRF_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const AT_1 = new Date('2030-08-27T10:00:00.000Z');
const AT_2 = new Date('2030-08-27T10:01:00.000Z');
const AT_3 = new Date('2030-08-27T10:02:00.000Z');
const AT_4 = new Date('2030-08-27T10:03:00.000Z');
const AT_5 = new Date('2030-08-27T10:04:00.000Z');
const AT_6 = new Date('2030-08-27T10:05:00.000Z');
const AT_7 = new Date('2030-08-27T10:06:00.000Z');

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function deleteLocationHistory(pool) {
  await pool.query('ALTER TABLE tenant_location_revisions DISABLE TRIGGER USER');
  try {
    await pool.query('DELETE FROM tenant_location_revisions WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE tenant_location_revisions ENABLE TRIGGER USER');
  }
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, TENANT_IDS);
  await deleteLocationHistory(pool);
  await pool.query('DELETE FROM booking_provider_references WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM microsoft365_room_mappings WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('DELETE FROM integrations WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANT_IDS]);
  await clearSaas3TestState(pool);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANT_IDS]);
}

async function seedTenant(pool, { tenantId, adminId, siteId, roomId }) {
  await pool.query(
    "INSERT INTO tenants (id, display_name, status) VALUES ($1, $2, 'active')",
    [tenantId, `Tenant ${siteId}`],
  );
  await pool.query(
    'INSERT INTO users (tenant_id, id, display_name) VALUES ($1, $2, $3)',
    [tenantId, adminId, `Admin ${siteId}`],
  );
  await pool.query({
    text: `
      INSERT INTO sites (tenant_id, id, name, active, time_zone, details)
      VALUES ($1, $2, $3, true, 'Europe/Berlin', '{"address": null}'::jsonb)
    `,
    values: [tenantId, siteId, `Site ${siteId}`],
  });
  await pool.query({
    text: `
      INSERT INTO rooms (tenant_id, id, site_id, name, capacity, active, details)
      VALUES ($1, $2, $3, $4, 12, true, $5::jsonb)
    `,
    values: [tenantId, roomId, siteId, `Room ${roomId}`, JSON.stringify({
      floor: null,
      equipment: [],
      accessibility: [],
      serviceIds: [],
      cateringPackageIds: [],
      floorplanAssetId: null,
      mediaAssetIds: [],
    })],
  });
}

function changedConfiguration(current, { siteName, roomActive } = {}) {
  return {
    sites: current.sites.map((site) => ({
      ...site,
      ...(siteName === undefined ? {} : { name: siteName }),
    })),
    rooms: current.rooms.map((room) => ({
      ...room,
      ...(roomActive === undefined ? {} : { active: roomActive }),
    })),
  };
}

function locationAudit({
  tenantId = TENANT_A,
  actorUserId = ADMIN_A,
  occurredAt,
  correlationId = CORRELATION_A,
  operation,
  previousRevision,
  nextRevision,
}) {
  return normalizeAuditEvent({
    tenantId,
    actorUserId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_locations',
    targetId: 'locations',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    occurredAt: occurredAt.toISOString(),
    correlationId,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { domain: 'locations', operation },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });
}

function mappingAuditFactory(occurredAt) {
  return ({ roomId, operation, providerStatus }) => normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
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

function bookingChangeAudit(occurredAt) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    action: AUDIT_ACTION.REQUEST_BOOKING_CHANGE,
    targetType: 'request',
    targetId: BOOKING_CHANGE_REQUEST,
    previousState: null,
    newState: null,
    occurredAt: occurredAt.toISOString(),
    correlationId: CORRELATION_A,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'approve_begin' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

async function update(repository, {
  expectedRevision,
  configuration,
  changedAt,
  correlationId = CORRELATION_A,
  operation = 'locations_update',
  assertAuthorizedTransition = () => true,
}) {
  return repository.update({
    tenantId: TENANT_A,
    expectedRevision,
    nextRevision: expectedRevision + 1,
    configuration,
    changedAt,
    actorUserId: ADMIN_A,
    assertAuthorizedTransition,
    auditEvent: locationAudit({
      occurredAt: changedAt,
      correlationId,
      operation,
      previousRevision: expectedRevision,
      nextRevision: expectedRevision + 1,
    }),
  });
}

function request({ port, body }) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/application/configuration',
      method: 'PUT',
      headers: {
        Host: `localhost:${port}`,
        'X-CSRF-Token': CSRF_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(encoded),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    outgoing.on('error', reject);
    outgoing.write(encoded);
    outgoing.end();
  });
}

test('Tenant Locations persistence is revisioned, atomic, isolated and provider-import aware', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_SECRET });
  const repository = createPostgresTenantLocationRepository(pool, { auditRepository });
  const mappingRepository = createPostgresMicrosoft365RoomMappingRepository(pool, { auditRepository });
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  await seedTenant(pool, { tenantId: TENANT_A, adminId: ADMIN_A, siteId: SITE_A, roomId: ROOM_A });
  await seedTenant(pool, { tenantId: TENANT_B, adminId: ADMIN_B, siteId: SITE_B, roomId: ROOM_B });

  const initial = await repository.current(TENANT_A);
  assert.equal(initial.revision, 1);
  assert.equal(initial.configuration.sites[0].timeZone, 'Europe/Berlin');
  assert.equal((await repository.current(TENANT_B)).revision, 1);

  await assert.rejects(
    repository.update({
      tenantId: TENANT_A,
      expectedRevision: 1,
      nextRevision: 2,
      configuration: initial.configuration,
      changedAt: AT_1,
      actorUserId: ADMIN_A,
      auditEvent: locationAudit({
        occurredAt: AT_1,
        operation: 'missing_authorizer',
        previousRevision: 1,
        nextRevision: 2,
      }),
    }),
    /TENANT_LOCATION_TRANSITION_AUTHORIZATION_REQUIRED/,
  );
  assert.equal((await repository.current(TENANT_A)).revision, 1);

  const revisionTwo = await update(repository, {
    expectedRevision: 1,
    configuration: changedConfiguration(initial.configuration, { siteName: 'Berlin v2' }),
    changedAt: AT_1,
  });
  assert.equal(revisionTwo.revision, 2);
  assert.equal(revisionTwo.configuration.sites[0].name, 'Berlin v2');
  assert.deepEqual((await repository.history(TENANT_A, 10)).map(({ revision }) => revision), [2, 1]);
  let deniedAuthorizations = 0;
  await assert.rejects(
    update(repository, {
      expectedRevision: 2,
      configuration: changedConfiguration(revisionTwo.configuration, { siteName: 'Denied' }),
      changedAt: AT_2,
      operation: 'authorization_denied',
      assertAuthorizedTransition() {
        deniedAuthorizations += 1;
        throw new Error('EXPECTED_AUTHORIZATION_DENIAL');
      },
    }),
    /EXPECTED_AUTHORIZATION_DENIAL/,
  );
  assert.equal(deniedAuthorizations, 1);
  assert.equal((await repository.current(TENANT_A)).revision, 2);
  assert.equal((await repository.current(TENANT_A)).configuration.sites[0].name, 'Berlin v2');
  assert.equal((await repository.history(TENANT_B, 10)).length, 0);
  assert.equal((await repository.current(TENANT_B)).configuration.sites[0].id, SITE_B);

  let releaseSnapshot;
  let revisionObserved;
  const snapshotObserved = new Promise((resolve) => { revisionObserved = resolve; });
  const continueSnapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      let paused = false;
      return {
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (!paused && statement?.name === 'tenant-locations-revision') {
            paused = true;
            revisionObserved();
            await continueSnapshot;
          }
          return result;
        },
        release(error) { client.release(error); },
      };
    },
  };
  const snapshotRepository = createPostgresTenantLocationRepository(snapshotPool, { auditRepository });
  const inFlightSnapshot = snapshotRepository.current(TENANT_A);
  await snapshotObserved;
  try {
    const revisionThree = await update(repository, {
      expectedRevision: 2,
      configuration: changedConfiguration(revisionTwo.configuration, { siteName: 'Berlin v3' }),
      changedAt: AT_2,
    });
    assert.equal(revisionThree.revision, 3);
  } finally {
    releaseSnapshot();
  }
  const consistentSnapshot = await inFlightSnapshot;
  assert.equal(consistentSnapshot.revision, 2);
  assert.equal(consistentSnapshot.configuration.sites[0].name, 'Berlin v2');

  const beforeRace = await repository.current(TENANT_A);
  const raceAuthorizationSnapshots = [];
  const raceAuthorizer = (current) => {
    raceAuthorizationSnapshots.push(current.sites[0].name);
    return true;
  };
  const race = await Promise.all([
    update(repository, {
      expectedRevision: beforeRace.revision,
      configuration: changedConfiguration(beforeRace.configuration, { siteName: 'Race A' }),
      changedAt: AT_3,
      correlationId: CORRELATION_A,
      operation: 'race_a',
      assertAuthorizedTransition: raceAuthorizer,
    }),
    update(repository, {
      expectedRevision: beforeRace.revision,
      configuration: changedConfiguration(beforeRace.configuration, { siteName: 'Race B' }),
      changedAt: AT_3,
      correlationId: CORRELATION_B,
      operation: 'race_b',
      assertAuthorizedTransition: raceAuthorizer,
    }),
  ]);
  assert.equal(race.filter((result) => result.status === 'conflict').length, 1);
  assert.equal(race.filter((result) => result.revision === beforeRace.revision + 1).length, 1);
  assert.deepEqual(raceAuthorizationSnapshots, [beforeRace.configuration.sites[0].name]);
  const afterRace = await repository.current(TENANT_A);
  assert.equal(afterRace.revision, 4);
  assert.ok(['Race A', 'Race B'].includes(afterRace.configuration.sites[0].name));

  const failingRepository = createPostgresTenantLocationRepository(pool, {
    auditRepository: {
      async appendWithClient() { throw new Error('EXPECTED_AUDIT_FAILURE'); },
    },
  });
  await assert.rejects(
    update(failingRepository, {
      expectedRevision: afterRace.revision,
      configuration: changedConfiguration(afterRace.configuration, { siteName: 'Must Roll Back' }),
      changedAt: AT_4,
      operation: 'audit_failure',
    }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  const afterAuditFailure = await repository.current(TENANT_A);
  assert.equal(afterAuditFailure.revision, afterRace.revision);
  assert.equal(afterAuditFailure.configuration.sites[0].name, afterRace.configuration.sites[0].name);
  assert.equal(await repository.revision(TENANT_A, afterRace.revision + 1), null);

  await pool.query({
    text: `
      INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
        internal_participants, external_participants
      )
      VALUES ($1, 'future-request', $2, $3, 'Submitted', $4, $5, 1, 0)
    `,
    values: [TENANT_A, ADMIN_A, ROOM_A, new Date('2031-01-01T10:00:00Z'), new Date('2031-01-01T11:00:00Z')],
  });
  await assert.rejects(
    update(repository, {
      expectedRevision: afterRace.revision,
      configuration: changedConfiguration(afterRace.configuration, { roomActive: false }),
      changedAt: AT_4,
      operation: 'referenced_deactivation',
    }),
    (error) => error.code === 'TENANT_LOCATION_REFERENCED_REQUEST',
  );
  assert.equal((await repository.current(TENANT_A)).revision, afterRace.revision);
  await pool.query("DELETE FROM requests WHERE tenant_id = $1 AND id = 'future-request'", [TENANT_A]);

  await pool.query({
    text: `
      INSERT INTO integrations (
        tenant_id, id, provider, provider_reference, status, connection_version,
        last_verified_at, connection_reason, places_permission_status,
        calendars_permission_status, created_at, updated_at
      )
      VALUES ($1, $2, 'microsoft365', $3, 'connected', 1, $4, NULL, 'granted', 'granted', $4, $4)
    `,
    values: [TENANT_A, INTEGRATION_A, PROVIDER_TENANT_A, AT_4],
  });
  await pool.query({
    text: `
      INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
        internal_participants, external_participants, status_changed_at, created_at, updated_at
      )
      VALUES ($1, 'provider-reference-request', $2, $3, 'Cancelled', $4, $5, 1, 0, $6, $6, $6)
    `,
    values: [
      TENANT_A,
      ADMIN_A,
      ROOM_A,
      new Date('2029-01-01T10:00:00Z'),
      new Date('2029-01-01T11:00:00Z'),
      AT_4,
    ],
  });
  await pool.query({
    text: `
      INSERT INTO booking_provider_references (
        tenant_id, request_id, integration_id, provider_reference, idempotency_key, state,
        created_correlation_id, attempt_number, provider_connection_reference,
        provider_resource_reference, created_at, updated_at
      )
      VALUES ($1, 'provider-reference-request', $2, 'provider-event', $3, 'active',
        $4, 1, 'connection-reference', 'resource-reference', $5, $5)
    `,
    values: [TENANT_A, INTEGRATION_A, 'a'.repeat(64), CORRELATION_A, AT_4],
  });
  await assert.rejects(
    update(repository, {
      expectedRevision: afterRace.revision,
      configuration: changedConfiguration(afterRace.configuration, { roomActive: false }),
      changedAt: AT_4,
      operation: 'provider_reference_deactivation',
    }),
    (error) => error.code === 'TENANT_LOCATION_REFERENCED_PROVIDER',
  );
  assert.equal((await repository.current(TENANT_A)).revision, afterRace.revision);
  await pool.query(
    "DELETE FROM booking_provider_references WHERE tenant_id = $1 AND request_id = 'provider-reference-request'",
    [TENANT_A],
  );
  await pool.query(
    "DELETE FROM requests WHERE tenant_id = $1 AND id = 'provider-reference-request'",
    [TENANT_A],
  );
  const sourceRevision = afterRace.revision;
  const imported = await mappingRepository.importRooms({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    providerTenantReference: PROVIDER_TENANT_A,
    rooms: [{
      roomId: IMPORTED_ROOM,
      siteId: SITE_A,
      localName: 'Imported Room',
      localCapacity: 20,
      externalRoomId: 'provider-imported-room',
      resourceAddress: 'imported@example.invalid',
      providerDisplayName: 'Provider Imported Room',
      providerCapacity: 24,
    }],
    changedAt: AT_4,
    auditEventFor: mappingAuditFactory(AT_4),
  });
  assert.equal(imported[0].roomId, IMPORTED_ROOM);
  const afterImport = await repository.current(TENANT_A);
  assert.equal(afterImport.revision, sourceRevision + 1);
  assert.equal(afterImport.configuration.rooms.find(({ id }) => id === IMPORTED_ROOM).active, true);
  assert.ok(await repository.revision(TENANT_A, afterImport.revision));

  await mappingRepository.importRooms({
    tenantId: TENANT_A,
    actorUserId: ADMIN_A,
    integrationId: INTEGRATION_A,
    connectionVersion: 1,
    providerTenantReference: PROVIDER_TENANT_A,
    rooms: [{
      roomId: 'ignored-refresh-room-id',
      siteId: SITE_A,
      localName: 'Ignored Local Refresh',
      localCapacity: 99,
      externalRoomId: 'provider-imported-room',
      resourceAddress: 'imported-renamed@example.invalid',
      providerDisplayName: 'Provider Imported Room Renamed',
      providerCapacity: 30,
    }],
    changedAt: AT_5,
    auditEventFor: mappingAuditFactory(AT_5),
  });
  assert.equal((await repository.current(TENANT_A)).revision, afterImport.revision);

  const rollbackRevision = afterImport.revision + 1;
  let staleRollbackAuthorizations = 0;
  const staleRollback = await repository.rollback({
    tenantId: TENANT_A,
    expectedRevision: afterImport.revision - 1,
    nextRevision: afterImport.revision,
    sourceRevision: 999_999,
    changedAt: AT_5,
    actorUserId: ADMIN_A,
    assertAuthorizedTransition() {
      staleRollbackAuthorizations += 1;
      return true;
    },
    auditEvent: locationAudit({
      occurredAt: AT_5,
      operation: 'stale_rollback',
      previousRevision: afterImport.revision - 1,
      nextRevision: afterImport.revision,
    }),
  });
  assert.deepEqual(staleRollback, {
    status: 'conflict',
    currentRevision: afterImport.revision,
  });
  assert.equal(staleRollbackAuthorizations, 0);

  let rollbackAuthorizationDenials = 0;
  await assert.rejects(
    repository.rollback({
      tenantId: TENANT_A,
      expectedRevision: afterImport.revision,
      nextRevision: rollbackRevision,
      sourceRevision,
      changedAt: AT_5,
      actorUserId: ADMIN_A,
      assertAuthorizedTransition() {
        rollbackAuthorizationDenials += 1;
        throw new Error('EXPECTED_ROLLBACK_AUTHORIZATION_DENIAL');
      },
      auditEvent: locationAudit({
        occurredAt: AT_5,
        operation: 'rollback_authorization_denied',
        previousRevision: afterImport.revision,
        nextRevision: rollbackRevision,
      }),
    }),
    /EXPECTED_ROLLBACK_AUTHORIZATION_DENIAL/,
  );
  assert.equal(rollbackAuthorizationDenials, 1);
  const afterDeniedRollback = await repository.current(TENANT_A);
  assert.equal(afterDeniedRollback.revision, afterImport.revision);
  assert.equal(
    afterDeniedRollback.configuration.rooms.find(({ id }) => id === IMPORTED_ROOM).active,
    true,
  );
  assert.equal(await repository.revision(TENANT_A, rollbackRevision), null);

  let authorizedRollbackTransition = null;
  const rolledBack = await repository.rollback({
    tenantId: TENANT_A,
    expectedRevision: afterImport.revision,
    nextRevision: rollbackRevision,
    sourceRevision,
    changedAt: AT_5,
    actorUserId: ADMIN_A,
    assertAuthorizedTransition(current, proposed) {
      authorizedRollbackTransition = { current, proposed };
      return true;
    },
    auditEvent: locationAudit({
      occurredAt: AT_5,
      operation: 'locations_rollback',
      previousRevision: afterImport.revision,
      nextRevision: rollbackRevision,
    }),
  });
  assert.equal(
    authorizedRollbackTransition.current.rooms.find(({ id }) => id === IMPORTED_ROOM).active,
    true,
  );
  assert.equal(
    authorizedRollbackTransition.proposed.rooms.find(({ id }) => id === IMPORTED_ROOM).active,
    false,
  );
  const retainedRoom = rolledBack.configuration.rooms.find(({ id }) => id === IMPORTED_ROOM);
  assert.equal(retainedRoom.active, false);
  const persistedRollback = await repository.revision(TENANT_A, rollbackRevision);
  assert.deepEqual(persistedRollback.configuration, rolledBack.configuration);
  assert.deepEqual((await repository.current(TENANT_A)).configuration, rolledBack.configuration);
  assert.equal((await mappingRepository.listByTenantIdAndIntegrationId(TENANT_A, INTEGRATION_A)).length, 1);
  assert.equal((await repository.current(TENANT_B)).revision, 1);

  const reactivated = await update(repository, {
    expectedRevision: rollbackRevision,
    configuration: {
      ...rolledBack.configuration,
      rooms: rolledBack.configuration.rooms.map((room) => ({
        ...room,
        active: room.id === IMPORTED_ROOM ? true : room.active,
      })),
    },
    changedAt: AT_6,
    operation: 'prepare_booking_change_race',
  });
  await pool.query({
    text: `
      INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
        internal_participants, external_participants, status_changed_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, 'Confirmed', $5, $6, 4, 0, $7, $7, $7)
    `,
    values: [
      TENANT_A,
      BOOKING_CHANGE_REQUEST,
      ADMIN_A,
      ROOM_A,
      new Date('2031-02-01T10:00:00Z'),
      new Date('2031-02-01T11:00:00Z'),
      AT_6,
    ],
  });
  await pool.query({
    text: `
      INSERT INTO booking_change_requests (
        tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
        internal_participants, external_participants, base_request_updated_at,
        decided_by_user_id, rejection_reason, created_at, updated_at, initiator_role_at_action
      )
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, 4, 0, $8, NULL, NULL, $8, $8, 'conference_manager')
    `,
    values: [
      TENANT_A,
      BOOKING_CHANGE_ID,
      BOOKING_CHANGE_REQUEST,
      ADMIN_A,
      IMPORTED_ROOM,
      new Date('2031-02-01T10:00:00Z'),
      new Date('2031-02-01T11:00:00Z'),
      AT_6,
    ],
  });
  const deactivateImported = {
    ...reactivated.configuration,
    rooms: reactivated.configuration.rooms.map((room) => ({
      ...room,
      active: room.id === IMPORTED_ROOM ? false : room.active,
    })),
  };
  await pool.query({
    text: `
      UPDATE booking_change_requests
      SET status = 'applying', decided_by_user_id = $4,
          decider_role_at_action = 'conference_manager', updated_at = $5
      WHERE tenant_id = $1 AND request_id = $2 AND id = $3
    `,
    values: [TENANT_A, BOOKING_CHANGE_REQUEST, BOOKING_CHANGE_ID, ADMIN_A, AT_7],
  });
  await assert.rejects(
    update(repository, {
      expectedRevision: reactivated.revision,
      configuration: deactivateImported,
      changedAt: AT_7,
      operation: 'applying_target_deactivation',
    }),
    (error) => error.code === 'TENANT_LOCATION_REFERENCED_BOOKING_CHANGE',
  );
  assert.equal((await repository.current(TENANT_A)).revision, reactivated.revision);
  await pool.query({
    text: `
      UPDATE booking_change_requests
      SET status = 'pending', decided_by_user_id = NULL,
          decider_role_at_action = NULL, updated_at = $4
      WHERE tenant_id = $1 AND request_id = $2 AND id = $3
    `,
    values: [TENANT_A, BOOKING_CHANGE_REQUEST, BOOKING_CHANGE_ID, AT_7],
  });

  let releaseLocationLock;
  let locationLockObserved;
  const locationLocked = new Promise((resolve) => { locationLockObserved = resolve; });
  const continueLocation = new Promise((resolve) => { releaseLocationLock = resolve; });
  const pausingLocationPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      let paused = false;
      return {
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (!paused && statement?.name === 'tenant-locations-revision-lock') {
            paused = true;
            locationLockObserved();
            await continueLocation;
          }
          return result;
        },
        release(error) { client.release(error); },
      };
    },
  };
  let approvalLockAttempted;
  const approvalAttempted = new Promise((resolve) => { approvalLockAttempted = resolve; });
  const observingApprovalPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        async query(statement, values) {
          if (statement?.name === 'booking-change-tenant-location-authority') approvalLockAttempted();
          return client.query(statement, values);
        },
        release(error) { client.release(error); },
      };
    },
  };
  const pausingLocationRepository = createPostgresTenantLocationRepository(pausingLocationPool, { auditRepository });
  const bookingChangeRepository = createPostgresBookingChangeRepository(observingApprovalPool, { auditRepository });
  const inFlightDeactivation = update(pausingLocationRepository, {
    expectedRevision: reactivated.revision,
    configuration: deactivateImported,
    changedAt: AT_7,
    operation: 'booking_change_race_deactivation',
  });
  await locationLocked;
  const inFlightApproval = bookingChangeRepository.beginApproval({
    tenantId: TENANT_A,
    requestId: BOOKING_CHANGE_REQUEST,
    changeId: BOOKING_CHANGE_ID,
    deciderUserId: ADMIN_A,
    changedAt: AT_7,
    auditEvent: bookingChangeAudit(AT_7),
  });
  try {
    await Promise.race([
      approvalAttempted,
      inFlightApproval.then(() => { throw new Error('BOOKING_CHANGE_LOCATION_LOCK_NOT_OBSERVED'); }),
    ]);
  } finally {
    releaseLocationLock();
  }
  const [deactivated, approval] = await Promise.all([inFlightDeactivation, inFlightApproval]);
  assert.equal(deactivated.revision, reactivated.revision + 1);
  assert.equal(approval.status, 'blocked');
  assert.equal((await bookingChangeRepository.findOpen(TENANT_A, BOOKING_CHANGE_REQUEST)).status, 'pending');

  await pool.query(
    'UPDATE sites SET time_zone = NULL WHERE tenant_id = $1 AND id = $2',
    [TENANT_B, SITE_B],
  );
  const legacyTenantB = await repository.current(TENANT_B);
  const correctedTenantB = await repository.update({
    tenantId: TENANT_B,
    expectedRevision: 1,
    nextRevision: 2,
    configuration: {
      ...legacyTenantB.configuration,
      sites: legacyTenantB.configuration.sites.map((site) => ({
        ...site,
        timeZone: 'Europe/London',
      })),
    },
    changedAt: AT_6,
    actorUserId: ADMIN_B,
    assertAuthorizedTransition: () => true,
    auditEvent: locationAudit({
      tenantId: TENANT_B,
      actorUserId: ADMIN_B,
      occurredAt: AT_6,
      correlationId: CORRELATION_B,
      operation: 'legacy_time_zone_corrected',
      previousRevision: 1,
      nextRevision: 2,
    }),
  });
  assert.equal(correctedTenantB.revision, 2);
  await assert.rejects(
    repository.rollback({
      tenantId: TENANT_B,
      expectedRevision: 2,
      nextRevision: 3,
      sourceRevision: 1,
      changedAt: AT_7,
      actorUserId: ADMIN_B,
      assertAuthorizedTransition: () => true,
      auditEvent: locationAudit({
        tenantId: TENANT_B,
        actorUserId: ADMIN_B,
        occurredAt: AT_7,
        correlationId: CORRELATION_B,
        operation: 'legacy_time_zone_rollback',
        previousRevision: 2,
        nextRevision: 3,
      }),
    }),
    (error) => error.code === 'TENANT_SITE_TIME_ZONE_INVALID',
  );
  const afterRejectedLegacyRollback = await repository.current(TENANT_B);
  assert.equal(afterRejectedLegacyRollback.revision, 2);
  assert.equal(afterRejectedLegacyRollback.configuration.sites[0].timeZone, 'Europe/London');

  let legacyWrites = 0;
  const apiConfig = { ...loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_MAX: '20',
  }) };
  const apiServer = createHttpServer({
    config: apiConfig,
    logger: createLogger({ write() {} }),
    productionApplicationService: {
      async getConfiguration() { return {}; },
      async updateConfiguration() {
        legacyWrites += 1;
        await pool.query(
          "UPDATE sites SET name = 'LEGACY WRITE' WHERE tenant_id = $1 AND id = $2",
          [TENANT_A, SITE_A],
        );
        return {};
      },
    },
    resolvePrincipal: async () => ({
      userId: ADMIN_A,
      tenantId: TENANT_A,
      providerIdentity: { provider: 'test_oidc', reference: 'admin-a' },
      roles: [TENANT_ROLE.TENANT_ADMIN],
      permissions: [PERMISSION.TENANT_CONFIGURE],
      session: {
        id: SESSION_A,
        issuedAt: '2030-08-27T09:00:00.000Z',
        expiresAt: '2030-08-27T18:00:00.000Z',
        securityVersion: 1,
      },
    }),
    verifyCsrf: async (incoming) => incoming.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async () => ({
      id: TENANT_A,
      displayName: 'Tenant A',
      status: 'active',
      createdAt: '2030-08-27T08:00:00.000Z',
      updatedAt: '2030-08-27T08:00:00.000Z',
    }),
  });
  await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => new Promise((resolve, reject) => {
    apiServer.close((error) => error ? reject(error) : resolve());
  }));
  const port = apiServer.address().port;
  apiConfig.publicOrigin = `http://localhost:${port}`;
  const legacy = await request({ port, body: { sites: [] } });
  assert.equal(legacy.statusCode, 405);
  assert.equal(legacy.body.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(legacyWrites, 0);
  const siteAfterLegacyAttempt = await pool.query(
    'SELECT name FROM sites WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, SITE_A],
  );
  assert.notEqual(siteAfterLegacyAttempt.rows[0].name, 'LEGACY WRITE');
  assert.equal(await auditRepository.verifyTenantChain(TENANT_A), true);
});
