import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  createRequestV2Snapshot,
  priceRequestComposition,
} from '../src/domain/request-composition.js';
import {
  CURRENT_SCHEMA_VERSION,
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';
import { removeSaas2TenantAdministrationFixtures } from './support/saas2-tenant-cleanup.js';

const TENANT_ID = '71717171-7171-4171-8171-717171717171';
const TENANT_B_ID = '71717171-7171-4171-8271-717171717171';
const TENANT_C_ID = '71717171-7171-4171-8371-717171717171';
const USER_ID = '72727272-7272-4272-8272-727272727272';
const USER_B_ID = '72727272-7272-4272-8372-727272727272';
const DECIDER_ID = '73737373-7373-4373-8373-737373737373';
const CHANGE_ID = '74747474-7474-4474-8474-747474747474';
const CORRELATION_ID = '75747474-7474-4474-8474-747474747474';
const LEGACY_REQUEST_ID = 'legacy-request-v1';
const ZERO_PARTICIPANT_REQUEST_ID = 'legacy-zero-participants';
const V2_REQUEST_ID = 'request-v2';
const SITE_ID = 'migration-site';
const SITE_B_ID = 'migration-site-b';
const ROOM_ID = 'migration-room';
const CROSS_TENANT_ROOM_ID = 'cross-tenant-only-room';
const CREATED_AT = '2026-08-27T08:00:00.000Z';
const STARTS_AT = '2026-09-03T09:00:00.000Z';
const ENDS_AT = '2026-09-03T10:00:00.000Z';
const MIGRATION_VERSION = 27;

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

async function clean(pool) {
  const tenantIds = [TENANT_ID, TENANT_B_ID, TENANT_C_ID];
  await removeSaas2TenantAdministrationFixtures(pool, tenantIds);
  await pool.query(
    'DELETE FROM booking_change_requests WHERE tenant_id = ANY($1::uuid[])',
    [tenantIds],
  );
  await pool.query('DELETE FROM requests WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('DELETE FROM sites WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('DELETE FROM users WHERE tenant_id = ANY($1::uuid[])', [tenantIds]);
  await pool.query('DELETE FROM tenants WHERE id = ANY($1::uuid[])', [tenantIds]);
}

async function seedLegacy(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [TENANT_ID, 'Request composition migration Tenant', CREATED_AT],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES ($1, $2, 'Requester', $4, $4), ($1, $3, 'Decider', $4, $4)`,
    [TENANT_ID, USER_ID, DECIDER_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO sites (tenant_id, id, name, time_zone, created_at, updated_at)
     VALUES ($1, $2, 'Migration Site', 'Europe/Berlin', $3, $3)`,
    [TENANT_ID, SITE_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO rooms (
       tenant_id, id, site_id, name, capacity, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Migration Room', 20, $4, $4)`,
    [TENANT_ID, ROOM_ID, SITE_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO requests (
       tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
       internal_participants, external_participants, status_changed_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Submitted', $5, $6, 2, 1, $7, $7, $7)`,
    [TENANT_ID, LEGACY_REQUEST_ID, USER_ID, ROOM_ID, STARTS_AT, ENDS_AT, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO requests (
       tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
       internal_participants, external_participants, status_changed_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Submitted', $5, $6, 0, 0, $7, $7, $7)`,
    [
      TENANT_ID,
      ZERO_PARTICIPANT_REQUEST_ID,
      USER_ID,
      ROOM_ID,
      '2026-09-03T11:00:00.000Z',
      '2026-09-03T12:00:00.000Z',
      CREATED_AT,
    ],
  );
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [TENANT_B_ID, 'Request composition migration Tenant B', CREATED_AT],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES ($1, $2, 'Requester B', $3, $3)`,
    [TENANT_B_ID, USER_B_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO sites (tenant_id, id, name, time_zone, created_at, updated_at)
     VALUES ($1, $2, 'Migration Site B', 'Europe/Berlin', $3, $3)`,
    [TENANT_B_ID, SITE_B_ID, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO rooms (
       tenant_id, id, site_id, name, capacity, created_at, updated_at
     ) VALUES ($1, $2, $3, 'Cross-Tenant Room', 20, $4, $4)`,
    [TENANT_B_ID, CROSS_TENANT_ROOM_ID, SITE_B_ID, CREATED_AT],
  );
}

function v2Draft(internalParticipants = 2, externalParticipants = 1) {
  return {
    title: 'Migration proposal',
    roomId: ROOM_ID,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    internalParticipants,
    externalParticipants,
    serviceIds: [],
    catering: {
      participantCount: 0,
      packageSelection: null,
      itemQuantities: [],
    },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: {
      organization: 1,
      locations: 1,
      catalogue: 2,
      bookingPolicies: 1,
      costAllocation: 1,
    },
  };
}

function v2Snapshot(requestVersion, proposal = v2Draft()) {
  const room = {
    id: proposal.roomId,
    siteId: SITE_ID,
    name: 'Migration Room',
    price: { amountMinor: 0, currency: 'EUR' },
  };
  const catalogueSnapshot = {
    schemaVersion: 1,
    catalogRevision: proposal.configurationRevisions.catalogue,
    capturedAt: CREATED_AT,
    siteId: SITE_ID,
    roomId: proposal.roomId,
    services: [],
    equipment: [],
    cateringItems: [],
    catering: [],
  };
  const pricing = priceRequestComposition({
    draft: proposal,
    room,
    catalogueSnapshot,
    defaultCurrency: 'EUR',
  });
  return createRequestV2Snapshot({
    draft: proposal,
    requestVersion,
    capturedAt: CREATED_AT,
    room,
    catalogueSnapshot,
    bookingPolicySnapshot: {
      policyVersionId: 'policy-v1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      evaluatedAt: CREATED_AT,
      rules: {
        minimumLeadTimeMinutes: 0,
        maximumAdvanceMinutes: 527040,
        cancellationWindowMinutes: 0,
        changeWindowMinutes: 0,
        maximumParticipants: 500,
        allowedSiteIds: [],
        allowedRoomIds: [],
        allowedServiceIds: [],
      },
    },
    allocationSnapshot: {
      schemaVersion: 1,
      configurationRevision: proposal.configurationRevisions.costAllocation,
      snapshottedAt: CREATED_AT,
      model: 'percentage_basis_points',
      totalBasisPoints: 0,
      totalMinor: pricing.totalMinor,
      allocatedMinor: 0,
      unallocatedMinor: pricing.totalMinor,
      currency: pricing.currency,
      entries: [],
    },
    revisions: proposal.configurationRevisions,
    defaultCurrency: 'EUR',
  });
}

function calendarReplacement() {
  return {
    idempotencyKey: 'a'.repeat(64),
    integrationId: DECIDER_ID,
    previousProviderReference: 'previous-event',
    previousProviderResourceReference: 'previous-room-resource',
    providerReference: 'target-event',
    providerResourceReference: 'target-room-resource',
  };
}

async function insertV2Request(pool, {
  requestId = V2_REQUEST_ID,
  internalParticipants = 2,
  externalParticipants = 1,
  snapshot = v2Snapshot(1),
} = {}) {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const inserted = await client.query({
      text: `
        INSERT INTO requests (
          tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
          internal_participants, external_participants, schema_version, request_version,
          request_snapshot, status_changed_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, 'Submitted', $5, $6, $7, $8, 2, 1, $9::jsonb, $10, $10, $10
        )
      `,
      values: [
        TENANT_ID,
        requestId,
        USER_ID,
        ROOM_ID,
        STARTS_AT,
        ENDS_AT,
        internalParticipants,
        externalParticipants,
        JSON.stringify(snapshot),
        CREATED_AT,
      ],
    });
    const record = {
      schemaVersion: 2,
      version: 1,
      id: requestId,
      roomId: ROOM_ID,
      status: 'Submitted',
      statusReason: null,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      internalParticipants,
      externalParticipants,
      statusChangedAt: CREATED_AT,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      details: snapshot.details,
      pricing: snapshot.pricing,
      configurationRevisions: snapshot.configurationRevisions,
      policy: snapshot.policy,
      allocations: snapshot.allocations,
    };
    const revision = await client.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, $2, 1, 2, 'created', $3::jsonb, $4, $5, $6)
        RETURNING revision_sequence
      `,
      values: [
        TENANT_ID,
        requestId,
        JSON.stringify(record),
        CREATED_AT,
        USER_ID,
        CORRELATION_ID,
      ],
    });
    await client.query(
      `UPDATE requests
       SET current_revision_sequence = $3
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, requestId, revision.rows[0].revision_sequence],
    );
    await client.query('COMMIT');
    committed = true;
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    committed = true;
    throw error;
  } finally {
    if (!committed) await client.query('ROLLBACK');
    client.release();
  }
}

async function deleteRequestWithHistory(pool, requestId) {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE request_revisions DISABLE TRIGGER request_revisions_append_only',
    );
    await client.query(
      'DELETE FROM request_revisions WHERE tenant_id = $1 AND request_id = $2',
      [TENANT_ID, requestId],
    );
    await client.query(
      'DELETE FROM requests WHERE tenant_id = $1 AND id = $2',
      [TENANT_ID, requestId],
    );
    await client.query(
      'ALTER TABLE request_revisions ENABLE TRIGGER request_revisions_append_only',
    );
    await client.query('COMMIT');
    committed = true;
  } finally {
    if (!committed) await client.query('ROLLBACK');
    client.release();
  }
}

async function insertV2Change(pool, {
  draft = v2Draft(),
  snapshot = v2Snapshot(2, draft),
  changeId = CHANGE_ID,
} = {}) {
  return pool.query({
    text: `
      INSERT INTO booking_change_requests (
        tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
        internal_participants, external_participants, base_request_updated_at,
        request_schema_version, base_request_version, request_draft,
        proposed_request_snapshot, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10,
        2, 1, $11::jsonb, $12::jsonb, $10, $10
      )
    `,
    values: [
      TENANT_ID,
      changeId,
      LEGACY_REQUEST_ID,
      USER_ID,
      draft.roomId,
      draft.startsAt,
      draft.endsAt,
      draft.internalParticipants,
      draft.externalParticipants,
      CREATED_AT,
      JSON.stringify(draft),
      JSON.stringify(snapshot),
    ],
  });
}

test('migration 027 backfills explicit legacy history and enforces v2 integrity', async (t) => {
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => {
    await migrateUp(pool);
    await clean(pool);
    await pool.end();
  });

  await migrateUp(pool);
  await clean(pool);
  assert.equal(await rollbackToVersion(pool, MIGRATION_VERSION), true);
  assert.equal(await isPostgresSchemaReady(pool, 26), true);
  await seedLegacy(pool);

  await pool.query(
    `INSERT INTO requests (
       tenant_id, id, requester_user_id, room_id, status, status_reason,
       starts_at, ends_at, internal_participants, external_participants,
       status_changed_at, created_at, updated_at
     ) VALUES (
       $1, 'legacy-reason-review', $2, $3, 'Rejected', NULL,
       $4, $5, 1, 0, $6, $6, $6
     )`,
    [TENANT_ID, USER_ID, ROOM_ID, STARTS_AT, ENDS_AT, CREATED_AT],
  );
  await assert.rejects(
    migrateUp(pool),
    (error) => error.code === '55000'
      && error.message.includes('REQUEST_COMPOSITION_V2_LEGACY_REQUEST_REQUIRES_REVIEW'),
  );
  assert.equal(await isPostgresSchemaReady(pool, 26), true);
  await pool.query(
    "DELETE FROM requests WHERE tenant_id = $1 AND id = 'legacy-reason-review'",
    [TENANT_ID],
  );

  const before = await pool.query(
    'SELECT catalog_revision, updated_at FROM tenants WHERE id = $1',
    [TENANT_ID],
  );
  await migrateUp(pool);
  assert.equal(CURRENT_SCHEMA_VERSION, MIGRATION_VERSION);
  assert.equal(await isPostgresSchemaReady(pool), true);
  const migratedTenant = await pool.query(
    'SELECT updated_at FROM tenants WHERE id = $1',
    [TENANT_ID],
  );
  const reportIndexes = await pool.query(`
    SELECT
      to_regclass('public.requests_tenant_report_range_idx') AS range_name,
      to_regclass('public.requests_tenant_revision_watermark_idx') AS watermark_name,
      (
        SELECT is_identity
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'request_revisions'
          AND column_name = 'revision_sequence'
      ) AS revision_sequence_identity
  `);
  assert.deepEqual(reportIndexes.rows[0], {
    range_name: 'requests_tenant_report_range_idx',
    watermark_name: 'requests_tenant_revision_watermark_idx',
    revision_sequence_identity: 'YES',
  });

  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Post-migration Tenant', 'active', $2, $2)`,
    [TENANT_C_ID, CREATED_AT],
  );
  const futureTenantCatalogue = await pool.query(
    `SELECT revision.snapshot
     FROM tenants tenant
     JOIN tenant_catalogue_revisions revision
       ON revision.tenant_id = tenant.id AND revision.revision = tenant.catalog_revision
     WHERE tenant.id = $1`,
    [TENANT_C_ID],
  );
  assert.deepEqual(futureTenantCatalogue.rows[0].snapshot.roomPrices, []);

  const roomPrice = await pool.query(
    `SELECT price_minor::int AS amount_minor, currency
     FROM tenant_room_prices WHERE tenant_id = $1 AND room_id = $2`,
    [TENANT_ID, ROOM_ID],
  );
  assert.deepEqual(roomPrice.rows[0], { amount_minor: 0, currency: 'EUR' });

  const catalogue = await pool.query(
    `SELECT tenant.catalog_revision, revision.snapshot
     FROM tenants tenant
     JOIN tenant_catalogue_revisions revision
       ON revision.tenant_id = tenant.id AND revision.revision = tenant.catalog_revision
     WHERE tenant.id = $1`,
    [TENANT_ID],
  );
  assert.equal(Number(catalogue.rows[0].catalog_revision), 2);
  assert.deepEqual(catalogue.rows[0].snapshot.roomPrices, [{
    roomId: ROOM_ID,
    price: { amountMinor: 0, currency: 'EUR' },
  }]);

  const legacy = await pool.query(
    `SELECT schema_version, request_version, request_snapshot, current_revision_sequence
     FROM requests WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, LEGACY_REQUEST_ID],
  );
  assert.equal(legacy.rows[0].schema_version, 1);
  assert.equal(legacy.rows[0].request_version, '1');
  assert.equal(legacy.rows[0].request_snapshot, null);
  assert.equal(Number(legacy.rows[0].current_revision_sequence) > 0, true);
  const history = await pool.query(
    `SELECT operation, record, revision_sequence
     FROM request_revisions WHERE tenant_id = $1 AND request_id = $2`,
    [TENANT_ID, LEGACY_REQUEST_ID],
  );
  assert.equal(history.rows[0].operation, 'migrated_legacy');
  assert.equal(
    legacy.rows[0].current_revision_sequence,
    history.rows[0].revision_sequence,
  );
  assert.deepEqual({
    details: history.rows[0].record.details,
    pricing: history.rows[0].record.pricing,
    configurationRevisions: history.rows[0].record.configurationRevisions,
    policy: history.rows[0].record.policy,
    allocations: history.rows[0].record.allocations,
  }, {
    details: null,
    pricing: null,
    configurationRevisions: null,
    policy: null,
    allocations: null,
  });
  const zeroParticipantHistory = await pool.query(
    `SELECT record
     FROM request_revisions WHERE tenant_id = $1 AND request_id = $2`,
    [TENANT_ID, ZERO_PARTICIPANT_REQUEST_ID],
  );
  assert.deepEqual({
    internalParticipants: zeroParticipantHistory.rows[0].record.internalParticipants,
    externalParticipants: zeroParticipantHistory.rows[0].record.externalParticipants,
  }, {
    internalParticipants: 0,
    externalParticipants: 0,
  });

  await assert.rejects(
    pool.query(
      `UPDATE requests SET internal_participants = internal_participants + 1
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, LEGACY_REQUEST_ID],
    ),
    (error) => error.code === '23514'
      && error.message.includes('REQUEST_CURRENT_REVISION_RECORD_MISMATCH'),
  );
  await assert.rejects(
    pool.query(
      `UPDATE requests SET schema_version = 2, request_snapshot = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, LEGACY_REQUEST_ID],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `UPDATE requests SET schema_version = 2, request_snapshot = '{}'::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, LEGACY_REQUEST_ID],
    ),
    (error) => error.code === '23514',
  );
  const emptyNestedSnapshot = structuredClone(v2Snapshot(1));
  emptyNestedSnapshot.details = {};
  emptyNestedSnapshot.pricing = {};
  await assert.rejects(
    insertV2Request(pool, {
      requestId: 'empty-nested-snapshot',
      snapshot: emptyNestedSnapshot,
    }),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    insertV2Request(pool, {
      requestId: 'too-many-participants',
      internalParticipants: 500,
      externalParticipants: 1,
      snapshot: v2Snapshot(1),
    }),
    (error) => error.code === '23514',
  );
  await insertV2Request(pool);
  const v2Pointer = await pool.query(
    `SELECT request.current_revision_sequence, revision.revision_sequence
     FROM requests request
     JOIN request_revisions revision
       ON revision.tenant_id = request.tenant_id
      AND revision.request_id = request.id
      AND revision.revision_sequence = request.current_revision_sequence
     WHERE request.tenant_id = $1 AND request.id = $2`,
    [TENANT_ID, V2_REQUEST_ID],
  );
  assert.equal(v2Pointer.rowCount, 1);
  assert.equal(
    v2Pointer.rows[0].current_revision_sequence,
    v2Pointer.rows[0].revision_sequence,
  );
  await assert.rejects(
    pool.query(
      `UPDATE requests
       SET current_revision_sequence = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, V2_REQUEST_ID],
    ),
    (error) => error.code === '23514'
      && error.message.includes('REQUEST_CURRENT_REVISION_INVALID'),
  );
  await assert.rejects(
    rollbackToVersion(pool, MIGRATION_VERSION),
    (error) => error.code === '55000'
      && error.message.includes('REQUEST_COMPOSITION_V2_ROLLBACK_REQUIRES_REVIEW'),
  );
  await deleteRequestWithHistory(pool, V2_REQUEST_ID);

  await assert.rejects(
    pool.query(
      `INSERT INTO request_revisions (
         tenant_id, request_id, request_version, schema_version, operation,
         record, captured_at, actor_user_id, correlation_id
       ) VALUES ($1, $2, 2, 1, 'transitioned', '{}'::jsonb, $3, NULL, NULL)`,
      [TENANT_ID, LEGACY_REQUEST_ID, CREATED_AT],
    ),
    (error) => error.code === '23514',
  );
  const malformedRecord = {
    ...history.rows[0].record,
    version: 2,
    status: null,
  };
  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, $2, 2, 1, 'transitioned', $3::jsonb, $4, NULL, NULL)
      `,
      values: [TENANT_ID, LEGACY_REQUEST_ID, JSON.stringify(malformedRecord), CREATED_AT],
    }),
    (error) => error.code === '23514',
  );
  const extraMigrationSeed = {
    ...history.rows[0].record,
    version: 2,
  };
  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, $2, 2, 1, 'migrated_legacy', $3::jsonb, $4, NULL, NULL)
      `,
      values: [TENANT_ID, LEGACY_REQUEST_ID, JSON.stringify(extraMigrationSeed), CREATED_AT],
    }),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `UPDATE request_revisions SET captured_at = captured_at
       WHERE tenant_id = $1 AND request_id = $2`,
      [TENANT_ID, LEGACY_REQUEST_ID],
    ),
    (error) => error.code === '55000',
  );

  await assert.rejects(
    insertV2Change(pool, {
      changeId: '75757575-7575-4575-8575-757575757575',
      snapshot: v2Snapshot(3),
    }),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '76757575-7575-4575-8575-757575757575',
      draft: v2Draft(500, 1),
      snapshot: v2Snapshot(2),
    }),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '77757575-7575-4575-8575-757575757575',
      draft: { ...v2Draft(), unexpected: true },
      snapshot: v2Snapshot(2),
    }),
    (error) => error.code === '23514',
  );
  const emptyNestedProposal = structuredClone(v2Snapshot(2));
  emptyNestedProposal.details = {};
  emptyNestedProposal.pricing = {};
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '78757575-7575-4575-8575-757575757575',
      snapshot: emptyNestedProposal,
    }),
    (error) => error.code === '23514',
  );
  const mismatchedDetails = structuredClone(v2Snapshot(2));
  mismatchedDetails.details.title = 'Different proposal title';
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '79757575-7575-4575-8575-757575757575',
      snapshot: mismatchedDetails,
    }),
    (error) => error.code === '23514',
  );
  const mismatchedSelection = structuredClone(v2Snapshot(2));
  mismatchedSelection.pricing.catering.participantCount = 1;
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '80757575-7575-4575-8575-757575757575',
      snapshot: mismatchedSelection,
    }),
    (error) => error.code === '23514',
  );
  const mismatchedRevisions = structuredClone(v2Snapshot(2));
  mismatchedRevisions.configurationRevisions.catalogue = 3;
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '81757575-7575-4575-8575-757575757575',
      snapshot: mismatchedRevisions,
    }),
    (error) => error.code === '23514',
  );
  const mismatchedAllocations = structuredClone(v2Snapshot(2));
  mismatchedAllocations.allocations.entries = [{
    costCenterId: 'unexpected-cost-center',
    percentageBasisPoints: 10000,
  }];
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '82757575-7575-4575-8575-757575757575',
      snapshot: mismatchedAllocations,
    }),
    (error) => error.code === '23514',
  );
  const longDraft = {
    ...v2Draft(),
    endsAt: '2026-09-04T09:00:00.001Z',
  };
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '83757575-7575-4575-8575-757575757575',
      draft: longDraft,
      snapshot: v2Snapshot(2),
    }),
    (error) => error.code === '23514',
  );
  const crossTenantDraft = {
    ...v2Draft(),
    roomId: CROSS_TENANT_ROOM_ID,
  };
  await assert.rejects(
    insertV2Change(pool, {
      changeId: '84757575-7575-4575-8575-757575757575',
      draft: crossTenantDraft,
      snapshot: v2Snapshot(2, crossTenantDraft),
    }),
    (error) => error.code === '23503',
  );
  await insertV2Change(pool);
  const recoveryDefaults = await pool.query(
    `SELECT move_attempt_number, recovery_phase, calendar_replacement
     FROM booking_change_requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, CHANGE_ID],
  );
  assert.deepEqual(recoveryDefaults.rows[0], {
    move_attempt_number: 0,
    recovery_phase: 'none',
    calendar_replacement: null,
  });
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests SET room_id = 'different-room'
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, CHANGE_ID],
    ),
    (error) => error.code === '55000',
  );
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests
       SET move_attempt_number = 1, recovery_phase = 'move_pending', updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, CHANGE_ID, '2026-08-27T08:01:00.000Z'],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests
       SET status = 'superseded', updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, CHANGE_ID, '2026-08-27T08:01:00.000Z'],
    ),
    (error) => error.code === '23514',
  );
  await pool.query(
    `UPDATE booking_change_requests
     SET status = 'applying', decided_by_user_id = $3,
         move_attempt_number = 1, recovery_phase = 'move_pending', updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, CHANGE_ID, DECIDER_ID, '2026-08-27T08:01:00.000Z'],
  );
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests
       SET recovery_phase = 'target_active', calendar_replacement = '{}'::jsonb,
           updated_at = $3
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_ID, CHANGE_ID, '2026-08-27T08:02:00.000Z'],
    ),
    (error) => error.code === '23514',
  );
  await pool.query(
    `UPDATE booking_change_requests
     SET recovery_phase = 'target_active', calendar_replacement = $3::jsonb,
         updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [
      TENANT_ID,
      CHANGE_ID,
      JSON.stringify(calendarReplacement()),
      '2026-08-27T08:02:00.000Z',
    ],
  );
  const recoveryState = await pool.query(
    `SELECT move_attempt_number, recovery_phase, calendar_replacement
     FROM booking_change_requests
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, CHANGE_ID],
  );
  assert.deepEqual(recoveryState.rows[0], {
    move_attempt_number: 1,
    recovery_phase: 'target_active',
    calendar_replacement: calendarReplacement(),
  });
  await assert.rejects(
    rollbackToVersion(pool, MIGRATION_VERSION),
    (error) => error.code === '55000'
      && error.message.includes('REQUEST_COMPOSITION_V2_ROLLBACK_REQUIRES_REVIEW'),
  );
  await pool.query('DELETE FROM booking_change_requests WHERE tenant_id = $1', [TENANT_ID]);

  await pool.query(
    `UPDATE tenant_room_prices
     SET price_minor = 100, updated_at = GREATEST(updated_at, clock_timestamp())
     WHERE tenant_id = $1 AND room_id = $2`,
    [TENANT_ID, ROOM_ID],
  );
  await assert.rejects(
    rollbackToVersion(pool, MIGRATION_VERSION),
    (error) => error.code === '55000'
      && error.message.includes('REQUEST_COMPOSITION_V2_ROLLBACK_REQUIRES_REVIEW'),
  );
  await pool.query(
    `UPDATE tenant_room_prices price
     SET price_minor = 0,
         currency = organization.default_currency,
         created_at = state.migrated_at,
         updated_at = state.migrated_at
     FROM tenant_organization_settings organization, request_v2_migration_state state
     WHERE price.tenant_id = $1 AND price.room_id = $2
       AND organization.tenant_id = price.tenant_id
       AND state.tenant_id = price.tenant_id`,
    [TENANT_ID, ROOM_ID],
  );

  assert.equal(await rollbackToVersion(pool, MIGRATION_VERSION), true);
  assert.equal(await isPostgresSchemaReady(pool, 26), true);
  const restored = await pool.query(
    'SELECT catalog_revision, updated_at FROM tenants WHERE id = $1',
    [TENANT_ID],
  );
  assert.equal(Number(restored.rows[0].catalog_revision), 1);
  assert.equal(
    restored.rows[0].updated_at.toISOString(),
    migratedTenant.rows[0].updated_at.toISOString(),
  );
  const restoredFutureTenantCatalogue = await pool.query(
    `SELECT revision.snapshot
     FROM tenants tenant
     JOIN tenant_catalogue_revisions revision
       ON revision.tenant_id = tenant.id AND revision.revision = tenant.catalog_revision
     WHERE tenant.id = $1`,
    [TENANT_C_ID],
  );
  assert.equal(
    Object.hasOwn(restoredFutureTenantCatalogue.rows[0].snapshot, 'roomPrices'),
    false,
  );
  const removed = await pool.query({
    text: `
      SELECT
        to_regclass('public.tenant_room_prices') AS room_prices,
        to_regclass('public.request_revisions') AS request_revisions,
        to_regclass('public.requests_tenant_report_range_idx') AS report_index,
        to_regclass('public.requests_tenant_revision_watermark_idx') AS watermark_index,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'requests'
            AND column_name = 'request_snapshot'
        ) AS request_snapshot,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'requests'
            AND column_name = 'current_revision_sequence'
        ) AS current_revision_sequence
    `,
  });
  assert.deepEqual(removed.rows[0], {
    room_prices: null,
    request_revisions: null,
    report_index: null,
    watermark_index: null,
    request_snapshot: false,
    current_revision_sequence: false,
  });

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
