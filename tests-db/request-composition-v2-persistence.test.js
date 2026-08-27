import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import {
  RequestCompositionInputError,
  RequestCompositionUnavailableError,
} from '../src/domain/request-composition.js';
import { TenantBookingPolicyViolationError } from '../src/domain/tenant-booking-policies.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import {
  createPostgresBookingChangeRepository,
} from '../src/persistence/postgres/booking-change-repository.js';
import {
  createPostgresMicrosoft365CalendarAuthorityGuard,
} from '../src/persistence/postgres/calendar-authority-guard.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import {
  createPostgresTenantBookingPolicyRepository,
} from '../src/persistence/postgres/tenant-booking-policy-repository.js';
import {
  createPostgresTenantCatalogueRepository,
} from '../src/persistence/postgres/tenant-catalogue-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_A = '76767676-7676-4676-8676-767676767676';
const TENANT_B = '77777777-7777-4777-8777-777777777777';
const USER_A = '78787878-7878-4878-8878-787878787878';
const USER_B = '79797979-7979-4979-8979-797979797979';
const CORRELATION_A = '80808080-8080-4080-8080-808080808080';
const CORRELATION_B = '81808080-8080-4080-8080-808080808080';
const DIRECT_CHANGE_ID = '82808080-8080-4080-8080-808080808080';
const DIRECT_ATOMIC_CHANGE_ID = '83808080-8080-4080-8080-808080808080';
const APPROVAL_CHANGE_ID = '84808080-8080-4080-8080-808080808080';
const APPROVAL_ATOMIC_CHANGE_ID = '85808080-8080-4080-8080-808080808080';
const CATERING_ONLY_CHANGE_ID = '86808080-8080-4080-8080-808080808080';
const SUPERSEDED_CHANGE_ID = '87808080-8080-4080-8080-808080808080';
const APPROVAL_RACE_CHANGE_ID = '88808080-8080-4080-8080-808080808080';
const CHANGE_WINDOW_CHANGE_ID = '89808080-8080-4080-8080-808080808080';
const RECOVERY_CHANGE_ID = '90808080-8080-4080-8080-808080808080';
const SITE_A = 'request-site-a';
const ROOM_A = 'request-room-a';
const ROOM_B = 'request-room-b';
const LEGACY_RESUBMIT_REQUEST = 'legacy-resubmit-request';
const CREATED_AT = new Date('2026-08-27T09:00:00.000Z');
const STARTS_AT = '2026-09-03T09:00:00.000Z';
const ENDS_AT = '2026-09-03T10:00:00.000Z';
const AUDIT_KEY = 'request-composition-persistence-audit-key-32';
const TENANTS = [TENANT_A, TENANT_B];

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function within(promise, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function instrumentPool(pool, { beforeQuery = null, afterQuery = null } = {}) {
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        async query(...args) {
          const statement = args[0];
          const name = statement && typeof statement === 'object' ? statement.name : null;
          if (beforeQuery) await beforeQuery(name);
          const result = await client.query(...args);
          if (afterQuery) await afterQuery(name);
          return result;
        },
        release(error) {
          client.release(error);
        },
      };
    },
  };
}

async function clean(pool) {
  await removeSaas2TenantAdministrationFixtures(pool, TENANTS);
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM notifications WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  for (const table of [
    'catering_item_room_applicability',
    'catering_item_site_applicability',
    'catering_package_room_applicability',
    'catering_package_site_applicability',
    'service_room_applicability',
    'service_site_applicability',
    'catering_package_items',
    'catering_package_variants',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [TENANTS]);
  }
  for (const table of ['services', 'catering_packages', 'catering_items']) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [TENANTS]);
  }
  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
  try {
    await pool.query('DELETE FROM audit_events WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  } finally {
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
  }
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [TENANTS]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [TENANTS]);
}

async function seed(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Request Tenant A', 'active', $3, $3),
            ($2, 'Request Tenant B', 'active', $3, $3)`,
    [TENANT_A, TENANT_B, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES ($1, $2, 'Requester A', $5, $5), ($3, $4, 'Requester B', $5, $5)`,
    [TENANT_A, USER_A, TENANT_B, USER_B, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO sites (
       tenant_id, id, name, time_zone, created_at, updated_at
     ) VALUES ($1, $2, 'Request Site A', 'Europe/Berlin', $3, $3)`,
    [TENANT_A, SITE_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO rooms (
       tenant_id, id, site_id, name, capacity, created_at, updated_at
     ) VALUES
       ($1, $2, $4, 'Request Room A', 20, $5, $5),
       ($1, $3, $4, 'Request Room B', 20, $5, $5)`,
    [TENANT_A, ROOM_A, ROOM_B, SITE_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO tenant_room_prices (
       tenant_id, room_id, price_minor, currency, created_at, updated_at
     ) VALUES
       ($1, $2, 1000, 'EUR', $4, $4),
       ($1, $3, 1000, 'EUR', $4, $4)`,
    [TENANT_A, ROOM_A, ROOM_B, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO services (
       tenant_id, id, name, description, price_minor, currency, active,
       sort_order, created_at, updated_at
     ) VALUES ($1, 'video', 'Video service', NULL, 250, 'EUR', TRUE, 1, $2, $2)`,
    [TENANT_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO catering_items (
       tenant_id, id, name, description, price_minor, currency, active,
       sort_order, created_at, updated_at
     ) VALUES
       ($1, 'coffee', 'Coffee', NULL, 150, 'EUR', TRUE, 1, $2, $2),
       ($1, 'juice', 'Juice', NULL, 200, 'EUR', TRUE, 2, $2, $2)`,
    [TENANT_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO catering_packages (
       tenant_id, id, name, description, price_minor, currency, active,
       sort_order, created_at, updated_at
     ) VALUES ($1, 'meeting', 'Meeting package', NULL, 9999, 'EUR', TRUE, 1, $2, $2)`,
    [TENANT_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO catering_package_variants (
       tenant_id, package_id, id, name, description, active,
       price_minor, currency, sort_order, created_at, updated_at
     ) VALUES ($1, 'meeting', 'standard', 'Standard', NULL, TRUE, 500, 'EUR', 1, $2, $2)`,
    [TENANT_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO catering_package_items (tenant_id, package_id, item_id)
     VALUES ($1, 'meeting', 'coffee')`,
    [TENANT_A],
  );
  await pool.query({
    text: `
      INSERT INTO tenant_catalogue_revisions (
        tenant_id, revision, snapshot, effective_at, actor_user_id, correlation_id
      ) VALUES ($1, 2, $2::jsonb, $3, NULL, NULL)
    `,
    values: [TENANT_A, JSON.stringify(catalogueConfiguration()), CREATED_AT],
  });
  await pool.query(
    `UPDATE tenants SET catalog_revision = 2, updated_at = $2
     WHERE id = $1`,
    [TENANT_A, CREATED_AT],
  );
}

function catalogueConfiguration() {
  const entry = (id, name, amountMinor, order) => ({
    id,
    name,
    description: null,
    price: { amountMinor, currency: 'EUR' },
    active: true,
    order,
    siteIds: [],
    roomIds: [],
  });
  return {
    services: [entry('video', 'Video service', 250, 1)],
    equipment: [],
    cateringPackages: [{
      ...entry('meeting', 'Meeting package', 9999, 1),
      itemIds: ['coffee'],
      variants: [{
        id: 'standard',
        name: 'Standard',
        description: null,
        price: { amountMinor: 500, currency: 'EUR' },
        active: true,
        order: 1,
      }],
    }],
    cateringItems: [
      entry('coffee', 'Coffee', 150, 1),
      entry('juice', 'Juice', 200, 2),
    ],
    roomPrices: [ROOM_A, ROOM_B].map((roomId) => ({
      roomId,
      price: { amountMinor: 1000, currency: 'EUR' },
    })),
  };
}

function revisions(catalogue = 2, bookingPolicies = 1) {
  return {
    organization: 1,
    locations: 1,
    catalogue,
    bookingPolicies,
    costAllocation: 1,
  };
}

function draft(overrides = {}) {
  return {
    title: 'Request persistence test',
    roomId: ROOM_A,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    internalParticipants: 2,
    externalParticipants: 1,
    serviceIds: ['video'],
    catering: {
      participantCount: 2,
      packageSelection: { packageId: 'meeting', variantId: 'standard' },
      itemQuantities: [
        { itemId: 'coffee', quantity: 3 },
        { itemId: 'juice', quantity: 2 },
      ],
    },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: revisions(),
    ...overrides,
  };
}

function requestAudit(
  requestId,
  correlationId = CORRELATION_A,
  occurredAt = CREATED_AT,
) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    action: AUDIT_ACTION.REQUEST_CREATED,
    targetType: 'request',
    targetId: requestId,
    previousState: null,
    newState: { status: 'Submitted', schemaVersion: 2, requestVersion: 1 },
    occurredAt: occurredAt.toISOString(),
    correlationId,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation: 'request_create_v2' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

function configurationAudit({
  targetType,
  targetId,
  domain,
  previousRevision,
  nextRevision,
  occurredAt,
}) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType,
    targetId,
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    occurredAt: occurredAt.toISOString(),
    correlationId: CORRELATION_B,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { domain, operation: 'request_composition_race_test' },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });
}

function transitionAudit({
  requestId,
  previousStatus,
  nextStatus,
  occurredAt,
  correlationId = CORRELATION_B,
}) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    action: AUDIT_ACTION.REQUEST_TRANSITION,
    targetType: 'request',
    targetId: requestId,
    previousState: { status: previousStatus },
    newState: { status: nextStatus },
    occurredAt: occurredAt.toISOString(),
    correlationId,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { transition: 'request_resubmission_test' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

function bookingChangeAudit({
  requestId,
  occurredAt,
  operation,
  correlationId = CORRELATION_B,
}) {
  return normalizeAuditEvent({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    action: AUDIT_ACTION.REQUEST_BOOKING_CHANGE,
    targetType: 'request',
    targetId: requestId,
    previousState: null,
    newState: null,
    occurredAt: occurredAt.toISOString(),
    correlationId,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { operation },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

function bookingCalendarReplacement() {
  return {
    idempotencyKey: 'b'.repeat(64),
    integrationId: USER_A,
    previousProviderReference: 'previous-calendar-event',
    previousProviderResourceReference: 'previous-calendar-room',
    providerReference: 'target-calendar-event',
    providerResourceReference: 'target-calendar-room',
  };
}

function repository(pool, auditRepository) {
  return createPostgresRequestRepository(pool, {
    auditRepository,
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });
}

async function createConfirmedRequest({
  requests,
  requestId,
  requestDraft,
  createdAt,
  confirmedAt,
}) {
  const created = await requests.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId,
    requesterUserId: USER_A,
    requestDraft,
    createdAt,
    auditEvent: requestAudit(requestId, CORRELATION_A, createdAt),
  });
  assert.equal(created.status, 'created');
  const confirmed = await requests.transitionByTenantIdAndId({
    tenantId: TENANT_A,
    requestId,
    actorUserId: USER_A,
    expectedStatus: 'Submitted',
    nextStatus: 'Confirmed',
    reason: null,
    changedAt: confirmedAt,
    auditEvent: transitionAudit({
      requestId,
      previousStatus: 'Submitted',
      nextStatus: 'Confirmed',
      occurredAt: confirmedAt,
    }),
  });
  assert.equal(confirmed.status, 'Confirmed');
  assert.equal(confirmed.version, 2);
  return confirmed;
}

async function insertLegacyChangeRequested(pool) {
  const startsAt = '2026-09-08T09:00:00.000Z';
  const endsAt = '2026-09-08T10:00:00.000Z';
  const changedAt = '2026-08-27T09:05:00.000Z';
  const record = {
    schemaVersion: 1,
    version: 1,
    id: LEGACY_RESUBMIT_REQUEST,
    roomId: ROOM_A,
    status: 'Change Requested',
    statusReason: 'Please update',
    startsAt,
    endsAt,
    internalParticipants: 2,
    externalParticipants: 1,
    statusChangedAt: changedAt,
    createdAt: CREATED_AT.toISOString(),
    updatedAt: changedAt,
    details: null,
    pricing: null,
    configurationRevisions: null,
    policy: null,
    allocations: null,
  };
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO requests (
         tenant_id, id, requester_user_id, room_id, status, status_reason,
         starts_at, ends_at, internal_participants, external_participants,
         schema_version, request_version, request_snapshot,
         status_changed_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, 'Change Requested', 'Please update',
         $5, $6, 2, 1, 1, 1, NULL, $7, $8, $7
       )`,
      [
        TENANT_A,
        LEGACY_RESUBMIT_REQUEST,
        USER_A,
        ROOM_A,
        startsAt,
        endsAt,
        changedAt,
        CREATED_AT,
      ],
    );
    const revision = await client.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, $2, 1, 1, 'migrated_legacy', $3::jsonb, $4, NULL, NULL)
        RETURNING revision_sequence
      `,
      values: [TENANT_A, LEGACY_RESUBMIT_REQUEST, JSON.stringify(record), changedAt],
    });
    await client.query(
      `UPDATE requests
       SET current_revision_sequence = $3
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, LEGACY_RESUBMIT_REQUEST, revision.rows[0].revision_sequence],
    );
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
    client.release();
  }
}

test('Request v2 persistence is tenant-scoped, versioned, priced and audit-atomic', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await clean(pool);
    await pool.end();
  });
  await migrateUp(pool);
  await clean(pool);
  await seed(pool);

  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: AUDIT_KEY });
  const requests = repository(pool, auditRepository);
  const created = await requests.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'priced-request',
    requesterUserId: USER_A,
    requestDraft: draft(),
    createdAt: CREATED_AT,
    auditEvent: requestAudit('priced-request'),
  });
  assert.equal(created.status, 'created');
  assert.equal(created.request.schemaVersion, 2);
  assert.equal(created.request.version, 1);
  assert.deepEqual(created.request.snapshot.pricing.breakdown, {
    roomMinor: 1000,
    servicesMinor: 250,
    cateringPackageMinor: 1000,
    cateringItemsMinor: 400,
  });
  assert.equal(created.request.snapshot.pricing.totalMinor, 2650);
  assert.equal(
    created.request.snapshot.pricing.catering.items
      .find((entry) => entry.item.id === 'coffee').lineTotalMinor,
    0,
  );
  assert.equal(created.request.snapshot.allocations.unallocatedMinor, 2650);

  const history = await requests.listHistoryByTenantIdAndId(
    TENANT_A,
    'priced-request',
  );
  assert.deepEqual(history.map((entry) => [entry.version, entry.operation]), [[1, 'created']]);
  assert.equal(history[0].request.pricing.totalMinor, 2650);
  assert.deepEqual(
    await requests.listHistoryByTenantIdAndId(TENANT_B, 'priced-request'),
    [],
  );
  assert.equal(await requests.findByTenantIdAndId(TENANT_B, 'priced-request'), null);
  await assert.rejects(
    pool.query(
      `UPDATE request_revisions SET record = record
       WHERE tenant_id = $1 AND request_id = $2`,
      [TENANT_A, 'priced-request'],
    ),
    (error) => error.code === '55000',
  );

  const changeRequestedAt = new Date('2026-08-27T09:01:00.000Z');
  const changeRequested = await requests.transitionByTenantIdAndId({
    tenantId: TENANT_A,
    requestId: 'priced-request',
    actorUserId: USER_A,
    expectedStatus: 'Submitted',
    nextStatus: 'Change Requested',
    reason: 'Please adjust the request',
    changedAt: changeRequestedAt,
    auditEvent: transitionAudit({
      requestId: 'priced-request',
      previousStatus: 'Submitted',
      nextStatus: 'Change Requested',
      occurredAt: changeRequestedAt,
    }),
  });
  assert.equal(changeRequested.version, 2);
  const staleResubmission = await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'priced-request',
    requesterUserId: USER_A,
    expectedVersion: 1,
    requestDraft: draft(),
    changedAt: new Date('2026-08-27T09:02:00.000Z'),
    auditEvent: transitionAudit({
      requestId: 'priced-request',
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: new Date('2026-08-27T09:02:00.000Z'),
    }),
  });
  assert.deepEqual(staleResubmission, { status: 'state_conflict' });
  const resubmittedAt = new Date('2026-08-27T09:03:00.000Z');
  const resubmitted = await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'priced-request',
    requesterUserId: USER_A,
    expectedVersion: 2,
    requestDraft: draft({ title: 'Adjusted persistence request' }),
    changedAt: resubmittedAt,
    auditEvent: transitionAudit({
      requestId: 'priced-request',
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: resubmittedAt,
    }),
  });
  assert.equal(resubmitted.status, 'resubmitted');
  assert.equal(resubmitted.request.version, 3);
  assert.equal(resubmitted.request.snapshot.details.title, 'Adjusted persistence request');
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'priced-request'))
      .map((entry) => [entry.version, entry.operation]),
    [[3, 'resubmitted'], [2, 'transitioned'], [1, 'created']],
  );

  await insertLegacyChangeRequested(pool);
  const legacyUpgradeDraft = draft({
    title: 'Legacy request upgraded to v2',
    startsAt: '2026-09-08T09:00:00.000Z',
    endsAt: '2026-09-08T10:00:00.000Z',
  });
  const legacyResubmittedAt = new Date('2026-08-27T09:06:00.000Z');
  assert.deepEqual(await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: LEGACY_RESUBMIT_REQUEST,
    requesterUserId: USER_B,
    expectedVersion: 1,
    requestDraft: legacyUpgradeDraft,
    changedAt: legacyResubmittedAt,
    auditEvent: transitionAudit({
      requestId: LEGACY_RESUBMIT_REQUEST,
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: legacyResubmittedAt,
    }),
  }), { status: 'not_found' });
  assert.deepEqual(await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: LEGACY_RESUBMIT_REQUEST,
    requesterUserId: USER_A,
    expectedVersion: 2,
    requestDraft: legacyUpgradeDraft,
    changedAt: legacyResubmittedAt,
    auditEvent: transitionAudit({
      requestId: LEGACY_RESUBMIT_REQUEST,
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: legacyResubmittedAt,
    }),
  }), { status: 'state_conflict' });
  const legacyUpgrade = await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: LEGACY_RESUBMIT_REQUEST,
    requesterUserId: USER_A,
    expectedVersion: 1,
    requestDraft: legacyUpgradeDraft,
    changedAt: legacyResubmittedAt,
    auditEvent: transitionAudit({
      requestId: LEGACY_RESUBMIT_REQUEST,
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: legacyResubmittedAt,
    }),
  });
  assert.equal(legacyUpgrade.status, 'resubmitted');
  assert.equal(legacyUpgrade.request.schemaVersion, 2);
  assert.equal(legacyUpgrade.request.version, 2);
  const staleLegacyRetryAt = new Date('2026-08-27T09:07:00.000Z');
  assert.deepEqual(await requests.resubmitVersionedForTenant({
    tenantId: TENANT_A,
    requestId: LEGACY_RESUBMIT_REQUEST,
    requesterUserId: USER_A,
    expectedVersion: 1,
    requestDraft: legacyUpgradeDraft,
    changedAt: staleLegacyRetryAt,
    auditEvent: transitionAudit({
      requestId: LEGACY_RESUBMIT_REQUEST,
      previousStatus: 'Change Requested',
      nextStatus: 'Submitted',
      occurredAt: staleLegacyRetryAt,
    }),
  }), { status: 'state_conflict' });
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, LEGACY_RESUBMIT_REQUEST))
      .map((entry) => [entry.version, entry.schemaVersion, entry.operation]),
    [[2, 2, 'resubmitted'], [1, 1, 'migrated_legacy']],
  );

  const reportDrafts = [
    ['report-before', 'Report before boundary', '2026-09-30T23:00:00.000Z', '2026-09-30T23:30:00.000Z'],
    ['report-a', 'Report A', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z'],
    ['report-b', 'Report B', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z'],
    ['report-c', 'Report C', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z'],
    ['report-d', 'Report D', '2026-10-01T01:00:00.000Z', '2026-10-01T01:30:00.000Z'],
    ['report-e', 'Report E', '2026-10-02T09:00:00.000Z', '2026-10-02T09:30:00.000Z'],
    ['report-f', 'Report F', '2026-10-02T09:00:00.000Z', '2026-10-02T09:30:00.000Z'],
    ['report-g', 'Report G', '2026-10-02T10:00:00.000Z', '2026-10-02T10:30:00.000Z'],
    ['report-at-to', 'Report at exclusive boundary', '2026-10-03T00:00:00.000Z', '2026-10-03T00:30:00.000Z'],
  ];
  for (const [requestId, title, startsAt, endsAt] of reportDrafts) {
    const result = await requests.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId,
      requesterUserId: USER_A,
      requestDraft: draft({ title, startsAt, endsAt }),
      createdAt: CREATED_AT,
      auditEvent: requestAudit(requestId),
    });
    assert.equal(result.status, 'created');
  }
  const tenantBReportRecord = {
    schemaVersion: 1,
    version: 1,
    id: 'report-a',
    roomId: null,
    status: 'Submitted',
    statusReason: null,
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:30:00.000Z',
    internalParticipants: 1,
    externalParticipants: 0,
    statusChangedAt: CREATED_AT.toISOString(),
    createdAt: CREATED_AT.toISOString(),
    updatedAt: CREATED_AT.toISOString(),
    details: null,
    pricing: null,
    configurationRevisions: null,
    policy: null,
    allocations: null,
  };
  const legacyReportClient = await pool.connect();
  let legacyReportCommitted = false;
  try {
    await legacyReportClient.query('BEGIN');
    await legacyReportClient.query(
      `INSERT INTO requests (
         tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
         internal_participants, external_participants, status_changed_at, created_at, updated_at
       ) VALUES (
         $1, 'report-a', $2, NULL, 'Submitted',
         '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z',
         1, 0, $3, $3, $3
       )`,
      [TENANT_B, USER_B, CREATED_AT],
    );
    const legacyReportRevision = await legacyReportClient.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, 'report-a', 1, 1, 'migrated_legacy', $2::jsonb, $3, NULL, NULL)
        RETURNING revision_sequence
      `,
      values: [TENANT_B, JSON.stringify(tenantBReportRecord), CREATED_AT],
    });
    await legacyReportClient.query(
      `UPDATE requests
       SET current_revision_sequence = $2
       WHERE tenant_id = $1 AND id = 'report-a'`,
      [TENANT_B, legacyReportRevision.rows[0].revision_sequence],
    );
    await legacyReportClient.query('COMMIT');
    legacyReportCommitted = true;
  } finally {
    if (!legacyReportCommitted) await legacyReportClient.query('ROLLBACK');
    legacyReportClient.release();
  }
  const reportFrom = new Date('2026-10-01T00:00:00.000Z');
  const reportTo = new Date('2026-10-03T00:00:00.000Z');
  const reportRows = [];
  let reportSnapshot = null;
  let afterStartsAt = null;
  let afterRequestId = null;
  let pageNumber = 0;
  do {
    const loadedPage = await requests.listReportPageByTenantId({
      tenantId: TENANT_A,
      from: reportFrom,
      to: reportTo,
      snapshot: reportSnapshot,
      afterStartsAt,
      afterRequestId,
      limit: 3,
    });
    assert.equal(loadedPage.status, 'ready');
    if (reportSnapshot === null) reportSnapshot = loadedPage.snapshot;
    assert.deepEqual(loadedPage.snapshot, reportSnapshot);
    const page = loadedPage.requests;
    reportRows.push(...page);
    if (pageNumber === 0) {
      const reportChangeRequestedAt = new Date('2026-08-27T10:00:00.000Z');
      const changed = await requests.transitionByTenantIdAndId({
        tenantId: TENANT_A,
        requestId: 'report-f',
        actorUserId: USER_A,
        expectedStatus: 'Submitted',
        nextStatus: 'Change Requested',
        reason: 'Move after report snapshot',
        changedAt: reportChangeRequestedAt,
        auditEvent: transitionAudit({
          requestId: 'report-f',
          previousStatus: 'Submitted',
          nextStatus: 'Change Requested',
          occurredAt: reportChangeRequestedAt,
        }),
      });
      assert.equal(changed.version, 2);
      const reportResubmittedAt = new Date('2026-08-27T10:01:00.000Z');
      const moved = await requests.resubmitVersionedForTenant({
        tenantId: TENANT_A,
        requestId: 'report-f',
        requesterUserId: USER_A,
        expectedVersion: 2,
        requestDraft: draft({
          title: 'Report F moved after snapshot',
          startsAt: '2026-11-02T09:00:00.000Z',
          endsAt: '2026-11-02T09:30:00.000Z',
        }),
        changedAt: reportResubmittedAt,
        auditEvent: transitionAudit({
          requestId: 'report-f',
          previousStatus: 'Change Requested',
          nextStatus: 'Submitted',
          occurredAt: reportResubmittedAt,
        }),
      });
      assert.equal(moved.status, 'resubmitted');
    }
    if (page.length < 3) break;
    const last = page.at(-1);
    afterStartsAt = new Date(last.startsAt);
    afterRequestId = last.id;
    pageNumber += 1;
  } while (true);
  const expectedReportIds = [
    'report-a',
    'report-b',
    'report-c',
    'report-d',
    'report-e',
    'report-f',
    'report-g',
  ];
  assert.deepEqual(reportRows.map((request) => request.id), expectedReportIds);
  assert.equal(new Set(reportRows.map((request) => request.id)).size, expectedReportIds.length);
  for (const request of reportRows) {
    const expectedTitle = reportDrafts.find(([requestId]) => requestId === request.id)[1];
    assert.equal(request.schemaVersion, 2);
    assert.equal(request.details.title, expectedTitle);
    assert.equal(request.pricing.totalMinor, 2650);
    assert.deepEqual(request.configurationRevisions, revisions());
  }
  assert.equal(reportRows.some((request) => request.id === 'report-before'), false);
  assert.equal(reportRows.some((request) => request.id === 'report-at-to'), false);
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'report-f')).startsAt,
    '2026-11-02T09:00:00.000Z',
  );
  const tenantBReport = await requests.listReportPageByTenantId({
    tenantId: TENANT_B,
    from: reportFrom,
    to: reportTo,
    limit: 10,
  });
  assert.equal(tenantBReport.status, 'ready');
  assert.deepEqual(
    tenantBReport.requests.map((request) => [request.id, request.schemaVersion]),
    [['report-a', 1]],
  );

  const revisionAppended = deferred();
  const continueRevisionAppend = deferred();
  let revisionAppendPaused = false;
  const pausingRevisionPool = instrumentPool(pool, {
    async afterQuery(name) {
      if (revisionAppendPaused || name !== 'request-revision-append') return;
      revisionAppendPaused = true;
      revisionAppended.resolve();
      await continueRevisionAppend.promise;
    },
  });
  const watermarkLockAttempted = deferred();
  let watermarkObserved = false;
  const observingReportPool = instrumentPool(pool, {
    beforeQuery(name) {
      if (watermarkObserved || name !== 'request-revision-watermark-lock') return;
      watermarkObserved = true;
      watermarkLockAttempted.resolve();
    },
  });
  const pausingRevisionRequests = repository(pausingRevisionPool, auditRepository);
  const observingReportRequests = repository(observingReportPool, auditRepository);
  const inFlightCreatedAt = new Date('2026-08-27T10:02:00.000Z');
  const createInFlight = pausingRevisionRequests.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'report-inflight',
    requesterUserId: USER_A,
    requestDraft: draft({
      title: 'Committed before watermark capture',
      startsAt: '2026-10-02T11:00:00.000Z',
      endsAt: '2026-10-02T11:30:00.000Z',
    }),
    createdAt: inFlightCreatedAt,
    auditEvent: requestAudit('report-inflight', CORRELATION_A, inFlightCreatedAt),
  });
  await within(revisionAppended.promise, 'REVISION_APPEND_BARRIER');
  const captureAgainstInFlight = observingReportRequests.listReportPageByTenantId({
    tenantId: TENANT_A,
    from: reportFrom,
    to: reportTo,
    limit: 20,
  });
  try {
    await within(watermarkLockAttempted.promise, 'WATERMARK_LOCK_ATTEMPT');
  } finally {
    continueRevisionAppend.resolve();
  }
  const [inFlightCreated, capturedAfterCommit] = await within(
    Promise.all([createInFlight, captureAgainstInFlight]),
    'REVISION_WATERMARK_RACE',
  );
  assert.equal(inFlightCreated.status, 'created');
  assert.equal(capturedAfterCommit.status, 'ready');
  assert.equal(
    capturedAfterCommit.requests.filter((request) => request.id === 'report-inflight').length,
    1,
  );
  const inFlightPointer = await pool.query(
    `SELECT current_revision_sequence
     FROM requests WHERE tenant_id = $1 AND id = 'report-inflight'`,
    [TENANT_A],
  );
  assert.equal(
    Number(inFlightPointer.rows[0].current_revision_sequence)
      <= capturedAfterCommit.snapshot.revisionWatermark,
    true,
  );
  assert.equal(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'report-inflight')).length,
    1,
  );
  assert.equal(
    (await auditRepository.listByTenantId(TENANT_A, { limit: 100 }))
      .filter((entry) => entry.targetId === 'report-inflight').length,
    1,
  );

  const staleConfiguration = await requests.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'stale-configuration',
    requesterUserId: USER_A,
    requestDraft: draft({ configurationRevisions: revisions(3) }),
    createdAt: CREATED_AT,
    auditEvent: requestAudit('stale-configuration'),
  });
  assert.deepEqual(staleConfiguration, {
    status: 'configuration_conflict',
    revisions: revisions(),
  });
  await assert.rejects(
    requests.createVersionedForTenant({
      tenantId: TENANT_B,
      requestId: 'cross-tenant-room',
      requesterUserId: USER_B,
      requestDraft: draft({ configurationRevisions: revisions(1) }),
      createdAt: CREATED_AT,
      auditEvent: normalizeAuditEvent({
        ...requestAudit('cross-tenant-room'),
        tenantId: TENANT_B,
        actorUserId: USER_B,
      }),
    }),
    RequestCompositionUnavailableError,
  );

  await pool.query(
    `UPDATE services SET currency = 'USD'
     WHERE tenant_id = $1 AND id = 'video'`,
    [TENANT_A],
  );
  await assert.rejects(
    requests.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'mixed-currency',
      requesterUserId: USER_A,
      requestDraft: draft(),
      createdAt: CREATED_AT,
      auditEvent: requestAudit('mixed-currency'),
    }),
    (error) => error instanceof RequestCompositionInputError
      && error.code === 'REQUEST_MIXED_CURRENCY',
  );
  await pool.query(
    `UPDATE services SET currency = 'EUR'
     WHERE tenant_id = $1 AND id = 'video'`,
    [TENANT_A],
  );

  const failingRequests = repository(pool, {
    async appendWithClient() {
      throw new Error('EXPECTED_AUDIT_FAILURE');
    },
  });
  await assert.rejects(
    failingRequests.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'audit-rollback',
      requesterUserId: USER_A,
      requestDraft: draft(),
      createdAt: CREATED_AT,
      auditEvent: requestAudit('audit-rollback'),
    }),
    /EXPECTED_AUDIT_FAILURE/,
  );
  assert.equal(await requests.findByTenantIdAndId(TENANT_A, 'audit-rollback'), null);
  assert.deepEqual(
    await requests.listHistoryByTenantIdAndId(TENANT_A, 'audit-rollback'),
    [],
  );

  const bookingChanges = createPostgresBookingChangeRepository(pool, { auditRepository });
  const directDraft = draft({
    title: 'Direct participant change',
    startsAt: '2026-09-04T09:00:00.000Z',
    endsAt: '2026-09-04T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'direct-booking-change',
    requestDraft: directDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:10:00.000Z'),
  });
  const directChangedAt = new Date('2026-08-27T09:11:00.000Z');
  const directProposal = {
    ...directDraft,
    internalParticipants: 3,
    catering: {
      ...directDraft.catering,
      participantCount: 3,
    },
  };
  const directApplied = await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'direct-booking-change',
    changeId: DIRECT_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: directProposal,
    changedAt: directChangedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'direct-booking-change',
      occurredAt: directChangedAt,
      operation: 'propose',
    }),
  });
  assert.equal(directApplied.status, 'applied');
  assert.equal(directApplied.change.status, 'applied');
  assert.equal(directApplied.request.version, 3);
  assert.equal(directApplied.request.snapshot.requestVersion, 3);
  assert.equal(directApplied.request.snapshot.details.catering.participantCount, 3);
  const persistedDirect = await pool.query(
    `SELECT status, request_draft, proposed_request_snapshot
     FROM booking_change_requests WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, DIRECT_CHANGE_ID],
  );
  assert.equal(persistedDirect.rows[0].status, 'applied');
  assert.deepEqual(persistedDirect.rows[0].request_draft, directApplied.change.requestDraft);
  assert.deepEqual(
    persistedDirect.rows[0].proposed_request_snapshot,
    directApplied.request.snapshot,
  );
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'direct-booking-change'))
      .map((entry) => [entry.version, entry.operation]),
    [[3, 'booking_changed'], [2, 'transitioned'], [1, 'created']],
  );
  assert.deepEqual(
    (await auditRepository.listByTenantId(TENANT_A, { limit: 100 }))
      .filter((entry) => entry.targetId === 'direct-booking-change'
        && entry.action === AUDIT_ACTION.REQUEST_BOOKING_CHANGE)
      .map((entry) => entry.metadata.operation),
    ['propose'],
  );
  const directNotifications = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE tenant_id = $1 AND user_id = $2 AND kind = 'booking_change_applied'`,
    [TENANT_A, USER_A],
  );
  assert.equal(directNotifications.rows[0].count, 1);

  const cateringOnlyDraft = draft({
    title: 'Catering participant-count approval change',
    startsAt: '2026-09-04T12:00:00.000Z',
    endsAt: '2026-09-04T13:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'catering-count-booking-change',
    requestDraft: cateringOnlyDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:12:00.000Z'),
  });
  const cateringOnlyChangedAt = new Date('2026-08-27T09:13:00.000Z');
  const cateringOnly = await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'catering-count-booking-change',
    changeId: CATERING_ONLY_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: {
      ...cateringOnlyDraft,
      catering: { ...cateringOnlyDraft.catering, participantCount: 3 },
    },
    changedAt: cateringOnlyChangedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'catering-count-booking-change',
      occurredAt: cateringOnlyChangedAt,
      operation: 'propose',
    }),
  });
  assert.equal(cateringOnly.status, 'pending');
  assert.equal(cateringOnly.change.requestDraft.internalParticipants, 2);
  assert.equal(cateringOnly.change.requestDraft.externalParticipants, 1);
  assert.equal(cateringOnly.change.requestDraft.catering.participantCount, 3);
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'catering-count-booking-change')).version,
    2,
  );

  const directAtomicDraft = draft({
    title: 'Direct atomicity change',
    startsAt: '2026-09-05T09:00:00.000Z',
    endsAt: '2026-09-05T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'direct-booking-atomic',
    requestDraft: directAtomicDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:20:00.000Z'),
  });
  const failingBookingChanges = createPostgresBookingChangeRepository(pool, {
    auditRepository: {
      async appendWithClient() {
        throw new Error('EXPECTED_BOOKING_AUDIT_FAILURE');
      },
    },
  });
  const directAtomicChangedAt = new Date('2026-08-27T09:21:00.000Z');
  await assert.rejects(
    failingBookingChanges.propose({
      tenantId: TENANT_A,
      requestId: 'direct-booking-atomic',
      changeId: DIRECT_ATOMIC_CHANGE_ID,
      initiatorUserId: USER_A,
      expectedVersion: 2,
      proposal: {
        ...directAtomicDraft,
        internalParticipants: 3,
        catering: { ...directAtomicDraft.catering, participantCount: 3 },
      },
      changedAt: directAtomicChangedAt,
      auditEvent: bookingChangeAudit({
        requestId: 'direct-booking-atomic',
        occurredAt: directAtomicChangedAt,
        operation: 'propose',
      }),
    }),
    /EXPECTED_BOOKING_AUDIT_FAILURE/,
  );
  assert.equal(await bookingChanges.findOpen(TENANT_A, 'direct-booking-atomic'), null);
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'direct-booking-atomic')).version,
    2,
  );
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'direct-booking-atomic'))
      .map((entry) => [entry.version, entry.operation]),
    [[2, 'transitioned'], [1, 'created']],
  );
  const afterDirectFailureNotifications = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE tenant_id = $1 AND user_id = $2 AND kind = 'booking_change_applied'`,
    [TENANT_A, USER_A],
  );
  assert.equal(afterDirectFailureNotifications.rows[0].count, 1);

  const approvalDraft = draft({
    title: 'Approval booking change',
    startsAt: '2026-09-06T09:00:00.000Z',
    endsAt: '2026-09-06T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'approval-booking-change',
    requestDraft: approvalDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:30:00.000Z'),
  });
  const approvalProposedAt = new Date('2026-08-27T09:31:00.000Z');
  const pendingApproval = await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'approval-booking-change',
    changeId: APPROVAL_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: { ...approvalDraft, specialRequirements: 'Board layout' },
    changedAt: approvalProposedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-booking-change',
      occurredAt: approvalProposedAt,
      operation: 'propose',
    }),
  });
  assert.equal(pendingApproval.status, 'pending');
  assert.equal(pendingApproval.change.proposedRequestSnapshot.requestVersion, 3);
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'approval-booking-change')).version,
    2,
  );
  const approvalBegunAt = new Date('2026-08-27T09:32:00.000Z');
  const applying = await bookingChanges.beginApproval({
    tenantId: TENANT_A,
    requestId: 'approval-booking-change',
    changeId: APPROVAL_CHANGE_ID,
    deciderUserId: USER_A,
    changedAt: approvalBegunAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-booking-change',
      occurredAt: approvalBegunAt,
      operation: 'approve_begin',
    }),
  });
  assert.equal(applying.status, 'applying');
  const approvalFinishedAt = new Date('2026-08-27T09:33:00.000Z');
  const approved = await bookingChanges.finishApproval({
    tenantId: TENANT_A,
    requestId: 'approval-booking-change',
    changeId: APPROVAL_CHANGE_ID,
    changedAt: approvalFinishedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-booking-change',
      occurredAt: approvalFinishedAt,
      operation: 'approve_applied',
    }),
  });
  assert.equal(approved.status, 'applied');
  assert.equal(approved.request.version, 3);
  assert.equal(approved.request.snapshot.details.specialRequirements, 'Board layout');
  assert.deepEqual(approved.request.snapshot, pendingApproval.change.proposedRequestSnapshot);
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'approval-booking-change'))
      .map((entry) => [entry.version, entry.operation]),
    [[3, 'booking_changed'], [2, 'transitioned'], [1, 'created']],
  );
  assert.deepEqual(
    (await auditRepository.listByTenantId(TENANT_A, { limit: 100 }))
      .filter((entry) => entry.targetId === 'approval-booking-change'
        && entry.action === AUDIT_ACTION.REQUEST_BOOKING_CHANGE)
      .map((entry) => entry.metadata.operation),
    ['approve_applied', 'approve_begin', 'propose'],
  );
  const approvalRow = await pool.query(
    `SELECT status, decided_by_user_id FROM booking_change_requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, APPROVAL_CHANGE_ID],
  );
  assert.deepEqual(approvalRow.rows[0], {
    status: 'applied',
    decided_by_user_id: USER_A,
  });

  const approvalAtomicDraft = draft({
    title: 'Approval atomicity change',
    startsAt: '2026-09-07T09:00:00.000Z',
    endsAt: '2026-09-07T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'approval-booking-atomic',
    requestDraft: approvalAtomicDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:40:00.000Z'),
  });
  const approvalAtomicProposedAt = new Date('2026-08-27T09:41:00.000Z');
  const pendingAtomic = await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'approval-booking-atomic',
    changeId: APPROVAL_ATOMIC_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: { ...approvalAtomicDraft, specialRequirements: 'Atomic layout' },
    changedAt: approvalAtomicProposedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-booking-atomic',
      occurredAt: approvalAtomicProposedAt,
      operation: 'propose',
    }),
  });
  assert.equal(pendingAtomic.status, 'pending');
  const approvalAtomicBegunAt = new Date('2026-08-27T09:42:00.000Z');
  assert.equal((await bookingChanges.beginApproval({
    tenantId: TENANT_A,
    requestId: 'approval-booking-atomic',
    changeId: APPROVAL_ATOMIC_CHANGE_ID,
    deciderUserId: USER_A,
    changedAt: approvalAtomicBegunAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-booking-atomic',
      occurredAt: approvalAtomicBegunAt,
      operation: 'approve_begin',
    }),
  })).status, 'applying');
  const beforeFinishFailureNotifications = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE tenant_id = $1 AND user_id = $2 AND kind = 'booking_change_applied'`,
    [TENANT_A, USER_A],
  );
  const approvalAtomicFinishedAt = new Date('2026-08-27T09:43:00.000Z');
  await assert.rejects(
    failingBookingChanges.finishApproval({
      tenantId: TENANT_A,
      requestId: 'approval-booking-atomic',
      changeId: APPROVAL_ATOMIC_CHANGE_ID,
      changedAt: approvalAtomicFinishedAt,
      auditEvent: bookingChangeAudit({
        requestId: 'approval-booking-atomic',
        occurredAt: approvalAtomicFinishedAt,
        operation: 'approve_applied',
      }),
    }),
    /EXPECTED_BOOKING_AUDIT_FAILURE/,
  );
  const afterFailedFinish = await requests.findByTenantIdAndId(
    TENANT_A,
    'approval-booking-atomic',
  );
  assert.equal(afterFailedFinish.version, 2);
  assert.notDeepEqual(afterFailedFinish.snapshot, pendingAtomic.change.proposedRequestSnapshot);
  assert.equal(
    (await bookingChanges.findOpen(TENANT_A, 'approval-booking-atomic')).status,
    'applying',
  );
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'approval-booking-atomic'))
      .map((entry) => [entry.version, entry.operation]),
    [[2, 'transitioned'], [1, 'created']],
  );
  const afterFinishFailureNotifications = await pool.query(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE tenant_id = $1 AND user_id = $2 AND kind = 'booking_change_applied'`,
    [TENANT_A, USER_A],
  );
  assert.equal(
    afterFinishFailureNotifications.rows[0].count,
    beforeFinishFailureNotifications.rows[0].count,
  );

  const supersededDraft = draft({
    title: 'Pending change superseded by cancellation',
    startsAt: '2026-09-09T09:00:00.000Z',
    endsAt: '2026-09-09T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'superseded-booking-change',
    requestDraft: supersededDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:44:00.000Z'),
  });
  const supersededProposedAt = new Date('2026-08-27T09:45:00.000Z');
  assert.equal((await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'superseded-booking-change',
    changeId: SUPERSEDED_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: { ...supersededDraft, specialRequirements: 'Will be superseded' },
    changedAt: supersededProposedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'superseded-booking-change',
      occurredAt: supersededProposedAt,
      operation: 'propose',
    }),
  })).status, 'pending');
  const supersededAt = new Date('2026-08-27T09:46:00.000Z');
  const cancelled = await requests.transitionByTenantIdAndId({
    tenantId: TENANT_A,
    requestId: 'superseded-booking-change',
    actorUserId: USER_A,
    expectedStatus: 'Confirmed',
    nextStatus: 'Cancelled',
    reason: null,
    changedAt: supersededAt,
    auditEvent: transitionAudit({
      requestId: 'superseded-booking-change',
      previousStatus: 'Confirmed',
      nextStatus: 'Cancelled',
      occurredAt: supersededAt,
    }),
    bookingChangeAuditEvent: bookingChangeAudit({
      requestId: 'superseded-booking-change',
      occurredAt: supersededAt,
      operation: 'superseded',
    }),
  });
  assert.equal(cancelled.status, 'Cancelled');
  assert.equal(cancelled.version, 3);
  assert.equal(await bookingChanges.findOpen(TENANT_A, 'superseded-booking-change'), null);
  const supersededRow = await pool.query(
    `SELECT status, decided_by_user_id, rejection_reason
     FROM booking_change_requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, SUPERSEDED_CHANGE_ID],
  );
  assert.deepEqual(supersededRow.rows[0], {
    status: 'superseded',
    decided_by_user_id: USER_A,
    rejection_reason: null,
  });
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'superseded-booking-change'))
      .map((entry) => [entry.version, entry.operation, entry.request.status]),
    [
      [3, 'transitioned', 'Cancelled'],
      [2, 'transitioned', 'Confirmed'],
      [1, 'created', 'Submitted'],
    ],
  );
  assert.deepEqual(
    (await auditRepository.listByTenantId(TENANT_A, { limit: 100 }))
      .filter((entry) => entry.targetId === 'superseded-booking-change'
        && entry.action === AUDIT_ACTION.REQUEST_BOOKING_CHANGE)
      .map((entry) => entry.metadata.operation),
    ['superseded', 'propose'],
  );

  const approvalRaceDraft = draft({
    title: 'Approval versus cancellation race',
    startsAt: '2026-09-10T09:00:00.000Z',
    endsAt: '2026-09-10T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'approval-cancel-race',
    requestDraft: approvalRaceDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:47:00.000Z'),
  });
  const approvalRaceProposedAt = new Date('2026-08-27T09:48:00.000Z');
  assert.equal((await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'approval-cancel-race',
    changeId: APPROVAL_RACE_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: { ...approvalRaceDraft, specialRequirements: 'Race layout' },
    changedAt: approvalRaceProposedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-cancel-race',
      occurredAt: approvalRaceProposedAt,
      operation: 'propose',
    }),
  })).status, 'pending');

  const approvalRequestLocked = deferred();
  const continueApproval = deferred();
  let approvalPaused = false;
  const pausingBookingPool = instrumentPool(pool, {
    async afterQuery(name) {
      if (approvalPaused || name !== 'booking-change-lock-request') return;
      approvalPaused = true;
      approvalRequestLocked.resolve();
      await continueApproval.promise;
    },
  });
  const transitionLockAttempted = deferred();
  let transitionObserved = false;
  const observingRequestPool = instrumentPool(pool, {
    beforeQuery(name) {
      if (transitionObserved || name !== 'request-v2-authority-tenant-order-lock') return;
      transitionObserved = true;
      transitionLockAttempted.resolve();
    },
  });
  const racingBookingChanges = createPostgresBookingChangeRepository(
    pausingBookingPool,
    { auditRepository },
  );
  const racingRequests = repository(observingRequestPool, auditRepository);
  const approvalRaceBegunAt = new Date('2026-08-27T09:49:00.000Z');
  const beginRace = racingBookingChanges.beginApproval({
    tenantId: TENANT_A,
    requestId: 'approval-cancel-race',
    changeId: APPROVAL_RACE_CHANGE_ID,
    deciderUserId: USER_A,
    changedAt: approvalRaceBegunAt,
    auditEvent: bookingChangeAudit({
      requestId: 'approval-cancel-race',
      occurredAt: approvalRaceBegunAt,
      operation: 'approve_begin',
    }),
  });
  await within(approvalRequestLocked.promise, 'APPROVAL_REQUEST_LOCK');
  const approvalRaceCancelledAt = new Date('2026-08-27T09:50:00.000Z');
  const cancelRace = racingRequests.transitionByTenantIdAndId({
    tenantId: TENANT_A,
    requestId: 'approval-cancel-race',
    actorUserId: USER_A,
    expectedStatus: 'Confirmed',
    nextStatus: 'Cancelled',
    reason: null,
    changedAt: approvalRaceCancelledAt,
    auditEvent: transitionAudit({
      requestId: 'approval-cancel-race',
      previousStatus: 'Confirmed',
      nextStatus: 'Cancelled',
      occurredAt: approvalRaceCancelledAt,
    }),
    bookingChangeAuditEvent: bookingChangeAudit({
      requestId: 'approval-cancel-race',
      occurredAt: approvalRaceCancelledAt,
      operation: 'superseded',
    }),
  });
  try {
    await within(transitionLockAttempted.promise, 'CANCELLATION_LOCK_ATTEMPT');
  } finally {
    continueApproval.resolve();
  }
  const [approvalWon, cancellationLost] = await within(
    Promise.all([beginRace, cancelRace]),
    'APPROVAL_CANCELLATION_RACE',
  );
  assert.equal(approvalWon.status, 'applying');
  assert.equal(cancellationLost, null);
  const afterApprovalRace = await requests.findByTenantIdAndId(
    TENANT_A,
    'approval-cancel-race',
  );
  assert.equal(afterApprovalRace.status, 'Confirmed');
  assert.equal(afterApprovalRace.version, 2);
  assert.equal(
    (await bookingChanges.findOpen(TENANT_A, 'approval-cancel-race')).status,
    'applying',
  );
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'approval-cancel-race'))
      .map((entry) => [entry.version, entry.operation]),
    [[2, 'transitioned'], [1, 'created']],
  );

  const recoveryDraft = draft({
    title: 'Durable calendar move recovery',
    startsAt: '2026-09-11T09:00:00.000Z',
    endsAt: '2026-09-11T10:00:00.000Z',
  });
  await createConfirmedRequest({
    requests,
    requestId: 'calendar-move-recovery',
    requestDraft: recoveryDraft,
    createdAt: CREATED_AT,
    confirmedAt: new Date('2026-08-27T09:51:00.000Z'),
  });
  const recoveryProposedAt = new Date('2026-08-27T09:52:00.000Z');
  const recoveryPending = await bookingChanges.propose({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
    initiatorUserId: USER_A,
    expectedVersion: 2,
    proposal: { ...recoveryDraft, roomId: ROOM_B },
    changedAt: recoveryProposedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'calendar-move-recovery',
      occurredAt: recoveryProposedAt,
      operation: 'propose',
    }),
  });
  assert.equal(recoveryPending.status, 'pending');
  const recoveryBegunAt = new Date('2026-08-27T09:53:00.000Z');
  const movePending = await bookingChanges.beginApproval({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
    deciderUserId: USER_A,
    changedAt: recoveryBegunAt,
    auditEvent: bookingChangeAudit({
      requestId: 'calendar-move-recovery',
      occurredAt: recoveryBegunAt,
      operation: 'approve_begin',
    }),
  });
  assert.equal(movePending.status, 'applying');
  assert.equal(movePending.change.moveAttemptNumber, 1);
  assert.equal(movePending.change.recoveryPhase, 'move_pending');
  assert.equal(movePending.change.calendarReplacement, null);

  const targetRecordedAt = new Date('2026-08-27T09:54:00.000Z');
  const targetActive = await bookingChanges.recordCalendarMoveTarget({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
    moveAttemptNumber: 1,
    calendarReplacement: bookingCalendarReplacement(),
    changedAt: targetRecordedAt,
    auditEvent: bookingChangeAudit({
      requestId: 'calendar-move-recovery',
      occurredAt: targetRecordedAt,
      operation: 'calendar_target_recorded',
    }),
  });
  assert.equal(targetActive.recoveryPhase, 'target_active');
  assert.deepEqual(targetActive.calendarReplacement, bookingCalendarReplacement());
  const restoreBegunAt = new Date('2026-08-27T09:55:00.000Z');
  const restorePending = await bookingChanges.beginCalendarMoveRollback({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
    moveAttemptNumber: 1,
    changedAt: restoreBegunAt,
    auditEvent: bookingChangeAudit({
      requestId: 'calendar-move-recovery',
      occurredAt: restoreBegunAt,
      operation: 'calendar_restore_begin',
    }),
  });
  assert.equal(restorePending.recoveryPhase, 'restore_pending');
  assert.deepEqual(restorePending.calendarReplacement, bookingCalendarReplacement());
  const reconciliationRequiredAt = new Date('2026-08-27T09:56:00.000Z');
  const reconciliationRequired = await bookingChanges.markCalendarMoveReconciliationRequired({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
    moveAttemptNumber: 1,
    changedAt: reconciliationRequiredAt,
    auditEvent: bookingChangeAudit({
      requestId: 'calendar-move-recovery',
      occurredAt: reconciliationRequiredAt,
      operation: 'calendar_reconciliation_required',
    }),
  });
  assert.equal(reconciliationRequired.recoveryPhase, 'reconciliation_required');
  assert.deepEqual(
    reconciliationRequired.calendarReplacement,
    bookingCalendarReplacement(),
  );
  const reconciledState = await bookingChanges.findApprovalState({
    tenantId: TENANT_A,
    requestId: 'calendar-move-recovery',
    changeId: RECOVERY_CHANGE_ID,
  });
  assert.equal(reconciledState.status, 'reconciliation_required');
  assert.equal(reconciledState.change.moveAttemptNumber, 1);
  const persistedRecovery = await pool.query(
    `SELECT status, move_attempt_number, recovery_phase, calendar_replacement
     FROM booking_change_requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, RECOVERY_CHANGE_ID],
  );
  assert.deepEqual(persistedRecovery.rows[0], {
    status: 'applying',
    move_attempt_number: 1,
    recovery_phase: 'reconciliation_required',
    calendar_replacement: bookingCalendarReplacement(),
  });
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'calendar-move-recovery')).version,
    2,
  );

  const concurrent = await Promise.allSettled([
    requests.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'concurrent-request',
      requesterUserId: USER_A,
      requestDraft: draft(),
      createdAt: CREATED_AT,
      auditEvent: requestAudit('concurrent-request', CORRELATION_A),
    }),
    requests.createVersionedForTenant({
      tenantId: TENANT_A,
      requestId: 'concurrent-request',
      requesterUserId: USER_A,
      requestDraft: draft(),
      createdAt: CREATED_AT,
      auditEvent: requestAudit('concurrent-request', CORRELATION_B),
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    concurrent.filter((result) => result.status === 'rejected' && result.reason.code === '23505').length,
    1,
  );
  assert.equal(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'concurrent-request')).length,
    1,
  );
  const concurrentAudits = (await auditRepository.listByTenantId(TENANT_A, { limit: 100 }))
    .filter((entry) => entry.targetId === 'concurrent-request');
  assert.equal(concurrentAudits.length, 1);

  const bookingPolicyRepository = createPostgresTenantBookingPolicyRepository(
    pool,
    { auditRepository },
  );
  const currentPolicy = await bookingPolicyRepository.current(TENANT_A);
  assert.equal(currentPolicy.revision, 1);
  const policyChangedAt = new Date('2026-08-27T10:30:00.000Z');
  const policyUpdate = await bookingPolicyRepository.update({
    tenantId: TENANT_A,
    expectedRevision: 1,
    nextRevision: 2,
    configuration: {
      versions: [
        ...currentPolicy.configuration.versions,
        {
          id: 'request-change-window-v2',
          effectiveFrom: policyChangedAt.toISOString(),
          rules: {
            ...currentPolicy.configuration.versions.at(-1).rules,
            changeWindowMinutes: 180,
          },
        },
      ],
    },
    changedAt: policyChangedAt,
    actorUserId: USER_A,
    auditEvent: configurationAudit({
      targetType: 'booking_policies',
      targetId: 'tenant-booking-policies',
      domain: 'booking_policies',
      previousRevision: 1,
      nextRevision: 2,
      occurredAt: policyChangedAt,
    }),
  });
  assert.equal(policyUpdate.revision, 2);

  const changeWindowDraft = draft({
    title: 'Current booking inside change window',
    startsAt: '2026-08-27T11:00:00.000Z',
    endsAt: '2026-08-27T12:00:00.000Z',
    configurationRevisions: revisions(2, 2),
  });
  await createConfirmedRequest({
    requests,
    requestId: 'booking-change-window',
    requestDraft: changeWindowDraft,
    createdAt: new Date('2026-08-27T10:31:00.000Z'),
    confirmedAt: new Date('2026-08-27T10:32:00.000Z'),
  });
  const changeWindowProposedAt = new Date('2026-08-27T10:33:00.000Z');
  await assert.rejects(
    bookingChanges.propose({
      tenantId: TENANT_A,
      requestId: 'booking-change-window',
      changeId: CHANGE_WINDOW_CHANGE_ID,
      initiatorUserId: USER_A,
      expectedVersion: 2,
      proposal: {
        ...changeWindowDraft,
        startsAt: '2026-09-12T09:00:00.000Z',
        endsAt: '2026-09-12T10:00:00.000Z',
      },
      changedAt: changeWindowProposedAt,
      auditEvent: bookingChangeAudit({
        requestId: 'booking-change-window',
        occurredAt: changeWindowProposedAt,
        operation: 'propose',
      }),
    }),
    (error) => error instanceof TenantBookingPolicyViolationError
      && error.code === 'BOOKING_POLICY_CHANGE_WINDOW_VIOLATION',
  );
  assert.equal(await bookingChanges.findOpen(TENANT_A, 'booking-change-window'), null);
  assert.equal(
    (await requests.findByTenantIdAndId(TENANT_A, 'booking-change-window')).version,
    2,
  );
  assert.deepEqual(
    (await requests.listHistoryByTenantIdAndId(TENANT_A, 'booking-change-window'))
      .map((entry) => [entry.version, entry.operation]),
    [[2, 'transitioned'], [1, 'created']],
  );

  const requestTenantLocked = deferred();
  const continueRequestCreate = deferred();
  let requestCreatePaused = false;
  const pausingRequestPool = instrumentPool(pool, {
    async afterQuery(name) {
      if (requestCreatePaused || name !== 'request-v2-authority-tenant-lock') return;
      requestCreatePaused = true;
      requestTenantLocked.resolve();
      await continueRequestCreate.promise;
    },
  });
  const catalogueLockAttempted = deferred();
  let catalogueObserved = false;
  const observingCataloguePool = instrumentPool(pool, {
    beforeQuery(name) {
      if (catalogueObserved || name !== 'tenant-catalogue-current-lock') return;
      catalogueObserved = true;
      catalogueLockAttempted.resolve();
    },
  });
  const racingCreateRequests = repository(pausingRequestPool, auditRepository);
  const racingCatalogue = createPostgresTenantCatalogueRepository(
    observingCataloguePool,
    { auditRepository },
  );
  const settingsRaceCreatedAt = new Date('2026-08-27T10:40:00.000Z');
  const createAgainstOldSettings = racingCreateRequests.createVersionedForTenant({
    tenantId: TENANT_A,
    requestId: 'settings-race-request',
    requesterUserId: USER_A,
    requestDraft: draft({
      title: 'Coherent settings race snapshot',
      startsAt: '2026-09-14T09:00:00.000Z',
      endsAt: '2026-09-14T10:00:00.000Z',
      configurationRevisions: revisions(2, 2),
    }),
    createdAt: settingsRaceCreatedAt,
    auditEvent: requestAudit(
      'settings-race-request',
      CORRELATION_A,
      settingsRaceCreatedAt,
    ),
  });
  await within(requestTenantLocked.promise, 'REQUEST_SETTINGS_LOCK');
  const catalogueChangedAt = new Date('2026-08-27T10:41:00.000Z');
  const nextCatalogue = {
    ...catalogueConfiguration(),
    roomPrices: catalogueConfiguration().roomPrices.map((entry) => (
      entry.roomId === ROOM_A
        ? { ...entry, price: { amountMinor: 1100, currency: 'EUR' } }
        : entry
    )),
  };
  const replaceCatalogue = racingCatalogue.replace({
    tenantId: TENANT_A,
    actorUserId: USER_A,
    correlationId: CORRELATION_B,
    expectedRevision: 2,
    catalogue: nextCatalogue,
    changedAt: catalogueChangedAt,
    auditEventFor() {
      return configurationAudit({
        targetType: 'catalogue',
        targetId: 'tenant-catalogue',
        domain: 'catalogue',
        previousRevision: 2,
        nextRevision: 3,
        occurredAt: catalogueChangedAt,
      });
    },
  });
  try {
    await within(catalogueLockAttempted.promise, 'CATALOGUE_LOCK_ATTEMPT');
  } finally {
    continueRequestCreate.resolve();
  }
  const [settingsRaceRequest, catalogueRaceResult] = await within(
    Promise.all([createAgainstOldSettings, replaceCatalogue]),
    'REQUEST_CATALOGUE_RACE',
  );
  assert.equal(settingsRaceRequest.status, 'created');
  assert.equal(settingsRaceRequest.request.snapshot.configurationRevisions.catalogue, 2);
  assert.equal(settingsRaceRequest.request.snapshot.configurationRevisions.bookingPolicies, 2);
  assert.equal(settingsRaceRequest.request.snapshot.pricing.room.price.amountMinor, 1000);
  assert.equal(settingsRaceRequest.request.snapshot.pricing.totalMinor, 2650);
  assert.equal(catalogueRaceResult.status, 'updated');
  assert.equal(catalogueRaceResult.current.revision, 3);
  assert.equal(
    catalogueRaceResult.current.catalogue.roomPrices
      .find((entry) => entry.roomId === ROOM_A).price.amountMinor,
    1100,
  );
  const settingsRaceHistory = await requests.listHistoryByTenantIdAndId(
    TENANT_A,
    'settings-race-request',
  );
  assert.equal(settingsRaceHistory.length, 1);
  assert.equal(settingsRaceHistory[0].request.configurationRevisions.catalogue, 2);
  assert.equal(settingsRaceHistory[0].request.pricing.room.price.amountMinor, 1000);
  const currentCatalogue = await racingCatalogue.loadCurrent(TENANT_A);
  assert.equal(currentCatalogue.revision, 3);
  assert.equal(
    currentCatalogue.catalogue.roomPrices
      .find((entry) => entry.roomId === ROOM_A).price.amountMinor,
    1100,
  );
  const raceAudits = await auditRepository.listByTenantId(TENANT_A, { limit: 100 });
  assert.equal(
    raceAudits.filter((entry) => entry.targetId === 'settings-race-request').length,
    1,
  );
  assert.equal(
    raceAudits.filter((entry) => entry.targetId === 'tenant-catalogue'
      && entry.metadata.operation === 'request_composition_race_test').length,
    1,
  );
});
