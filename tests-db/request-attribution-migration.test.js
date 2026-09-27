import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import {
  CURRENT_SCHEMA_VERSION,
  createPostgresPool,
  isPostgresSchemaReady,
} from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackToVersion } from '../scripts/db-migrations.mjs';

const TENANT_A = '91919191-9191-4191-8191-919191919191';
const TENANT_B = '92929292-9292-4292-8292-929292929292';
const REQUESTER = '93939393-9393-4393-8393-939393939393';
const MANAGER = '94949494-9494-4494-8494-949494949494';
const LEGACY_INITIATOR = 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3';
const LEGACY_DECIDER = 'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4';
const CORRELATION = '95959595-9595-4595-8595-959595959595';
const LEGACY_CHANGE = '96969696-9696-4696-8696-969696969696';
const SELF_CHANGE = '97979797-9797-4797-8797-979797979797';
const RETRY_CHANGE = '98989898-9898-4898-8898-989898989898';
const MISSING_ROLE_CHANGE = '99999999-9999-4999-8999-999999999999';
const BAD_INITIATOR_CHANGE = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const CREATED_AT = '2026-08-27T08:00:00.000Z';
const UPDATED_AT = '2026-08-27T09:00:00.000Z';
const STARTS_AT = '2026-09-03T09:00:00.000Z';
const ENDS_AT = '2026-09-03T10:00:00.000Z';

function databaseConfig() {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  return { mode: 'test', ...database };
}

function publicLegacyRequest(requestId, version, status, updatedAt) {
  return {
    schemaVersion: 1,
    version,
    id: requestId,
    roomId: 'room-a',
    status,
    statusReason: null,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    internalParticipants: 2,
    externalParticipants: 0,
    statusChangedAt: updatedAt,
    createdAt: CREATED_AT,
    updatedAt,
    details: null,
    pricing: null,
    configurationRevisions: null,
    policy: null,
    allocations: null,
  };
}

async function insertRequestWithRevision(client, {
  requestId,
  actorUserId,
  actorRoleAtAction = undefined,
  requesterUserId = REQUESTER,
  updatedAt = CREATED_AT,
  suppliedRequesterName = undefined,
  suppliedActorName = undefined,
}) {
  const requesterColumns = suppliedRequesterName === undefined
    ? ''
    : ', requester_display_name';
  const requesterValue = suppliedRequesterName === undefined ? '' : ', $11';
  const requestValues = [
    TENANT_A,
    requestId,
    requesterUserId,
    'room-a',
    STARTS_AT,
    ENDS_AT,
    CREATED_AT,
    updatedAt,
    1,
    null,
    suppliedRequesterName,
  ];
  await client.query({
    text: `
      INSERT INTO requests (
        tenant_id, id, requester_user_id, room_id, status, starts_at, ends_at,
        internal_participants, external_participants, status_changed_at, created_at,
        updated_at, schema_version, request_version, request_snapshot${requesterColumns}
      ) VALUES (
        $1, $2, $3, $4, 'Confirmed', $5, $6, 2, 0, $8, $7,
        $8, $9, 1, $10::jsonb${requesterValue}
      )
    `,
    values: requestValues.slice(0, suppliedRequesterName === undefined ? 10 : 11),
  });
  const roleColumns = actorRoleAtAction === undefined
    ? ''
    : ', actor_role_at_action, actor_display_name';
  const roleValues = actorRoleAtAction === undefined ? '' : ', $7, $8';
  const revision = await client.query({
    text: `
      INSERT INTO request_revisions (
        tenant_id, request_id, request_version, schema_version, operation,
        record, captured_at, actor_user_id, correlation_id${roleColumns}
      ) VALUES ($1, $2, 1, 1, 'created', $3::jsonb, $4, $5, $6${roleValues})
      RETURNING revision_sequence
    `,
    values: actorRoleAtAction === undefined
      ? [TENANT_A, requestId, JSON.stringify(publicLegacyRequest(requestId, 1, 'Confirmed', updatedAt)),
        updatedAt, actorUserId, actorUserId === null ? null : CORRELATION]
      : [TENANT_A, requestId, JSON.stringify(publicLegacyRequest(requestId, 1, 'Confirmed', updatedAt)),
        updatedAt, actorUserId, actorUserId === null ? null : CORRELATION,
        actorRoleAtAction, suppliedActorName],
  });
  await client.query(
    'UPDATE requests SET current_revision_sequence = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, requestId, revision.rows[0].revision_sequence],
  );
}

async function insertRequestTransaction(pool, values) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertRequestWithRevision(client, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedSchema35(pool) {
  await pool.query(
    `INSERT INTO tenants (id, display_name, status, created_at, updated_at)
     VALUES ($1, 'Attribution Tenant A', 'active', $3, $3),
            ($2, 'Attribution Tenant B', 'active', $3, $3)`,
    [TENANT_A, TENANT_B, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO users (tenant_id, id, display_name, created_at, updated_at)
     VALUES
       ($1, $3, 'Requester A', $5, $5),
       ($1, $4, 'Manager A', $5, $5),
       ($1, $6, 'Legacy initiator', $5, $5),
       ($1, $7, 'Legacy decider', $5, $5),
       ($2, $3, 'Foreign requester', $5, $5),
       ($2, $4, 'Foreign manager', $5, $5)`,
    [TENANT_A, TENANT_B, REQUESTER, MANAGER, CREATED_AT, LEGACY_INITIATOR, LEGACY_DECIDER],
  );
  await pool.query(
    `INSERT INTO sites (tenant_id, id, name, time_zone, created_at, updated_at)
     VALUES ($1, 'site-a', 'Attribution Site', 'Europe/Berlin', $2, $2)`,
    [TENANT_A, CREATED_AT],
  );
  await pool.query(
    `INSERT INTO rooms (tenant_id, id, site_id, name, capacity, created_at, updated_at)
     VALUES ($1, 'room-a', 'site-a', 'Attribution Room', 20, $2, $2)`,
    [TENANT_A, CREATED_AT],
  );

  await insertRequestTransaction(pool, {
    requestId: 'legacy-attribution',
    actorUserId: MANAGER,
  });
  await insertRequestTransaction(pool, {
    requestId: 'missing-legacy-actor',
    actorUserId: null,
  });
  await pool.query({
    text: `
      INSERT INTO booking_change_requests (
        tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
        internal_participants, external_participants, base_request_updated_at,
        request_schema_version, base_request_version, request_draft,
        proposed_request_snapshot, decided_by_user_id, rejection_reason, created_at, updated_at
      ) VALUES (
        $1, $2, 'legacy-attribution', $3, 'rejected', 'room-a', $4, $5,
        2, 0, $6, 1, 1, NULL, NULL, $7, 'Legacy rejection', $6, $6
      )
    `,
    values: [
      TENANT_A,
      LEGACY_CHANGE,
      LEGACY_INITIATOR,
      STARTS_AT,
      ENDS_AT,
      CREATED_AT,
      LEGACY_DECIDER,
    ],
  });
}

async function tableHasColumn(pool, tableName, columnName) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    [tableName, columnName],
  );
  return result.rows[0].present;
}

test('migration 036 preserves honest legacy attribution and enforces post-cutover snapshots', async (t) => {
  assert.equal(CURRENT_SCHEMA_VERSION, 39);
  const pool = createPostgresPool(databaseConfig());
  t.after(async () => pool.end());

  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackToVersion(pool, 36), true);
  assert.equal(await tableHasColumn(pool, 'requests', 'requester_display_name'), false);
  await migrateUp(pool);
  assert.equal(await tableHasColumn(pool, 'requests', 'requester_display_name'), true);
  assert.equal(await rollbackToVersion(pool, 36), true);

  await seedSchema35(pool);
  for (const [userId, attack, restored, constraint] of [
    [REQUESTER, 'Requester\u202espoof', 'Requester A', 'requests_requester_display_valid'],
    [MANAGER, 'Actor\u200bspoof', 'Manager A', 'request_revisions_actor_display_valid'],
    [
      LEGACY_INITIATOR,
      'Initiator\u2066spoof\u2069',
      'Legacy initiator',
      'booking_changes_initiator_display_valid',
    ],
    [
      LEGACY_DECIDER,
      'Decider\ufeffspoof',
      'Legacy decider',
      'booking_changes_decider_display_valid',
    ],
  ]) {
    await pool.query(
      'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, userId, attack],
    );
    await assert.rejects(
      migrateUp(pool),
      (error) => error?.code === '23514' && error.constraint === constraint,
    );
    assert.equal(await tableHasColumn(pool, 'requests', 'requester_display_name'), false);
    await pool.query(
      'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
      [TENANT_A, userId, restored],
    );
  }
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);

  const legacyRequest = await pool.query(
    `SELECT requester_display_name FROM requests
     WHERE tenant_id = $1 AND id = 'legacy-attribution'`,
    [TENANT_A],
  );
  assert.equal(legacyRequest.rows[0].requester_display_name, 'Requester A');
  const legacyRevision = await pool.query(
    `SELECT actor_display_name, actor_role_at_action FROM request_revisions
     WHERE tenant_id = $1 AND request_id = 'legacy-attribution'`,
    [TENANT_A],
  );
  assert.deepEqual(legacyRevision.rows[0], {
    actor_display_name: 'Manager A',
    actor_role_at_action: null,
  });
  const missingLegacyActor = await pool.query(
    `SELECT actor_display_name, actor_role_at_action FROM request_revisions
     WHERE tenant_id = $1 AND request_id = 'missing-legacy-actor'`,
    [TENANT_A],
  );
  assert.deepEqual(missingLegacyActor.rows[0], {
    actor_display_name: null,
    actor_role_at_action: null,
  });
  const legacyChange = await pool.query(
    `SELECT initiator_display_name, initiator_role_at_action,
            decider_display_name, decider_role_at_action
     FROM booking_change_requests WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, LEGACY_CHANGE],
  );
  assert.deepEqual(legacyChange.rows[0], {
    initiator_display_name: 'Legacy initiator',
    initiator_role_at_action: null,
    decider_display_name: 'Legacy decider',
    decider_role_at_action: null,
  });
  const migrationState = await pool.query(
    'SELECT post_cutover_evidence FROM request_attribution_migration_state',
  );
  assert.equal(migrationState.rows[0].post_cutover_evidence, false);
  for (const [displayName, expected] of [
    ['José 山田', true],
    ['Jose\u0301 山田', false],
    ['C1\u0085Control', false],
    ['Soft\u00adHyphen', false],
    ['Mark\u061cAdmin', false],
    ['Zero\u200bWidth', false],
    ['Manager\u202eresU', false],
    ['Line\u2028Break', false],
    ['Isolate\u2066Admin\u2069', false],
    ['Word\ufeffJoin', false],
  ]) {
    const valid = await pool.query(
      'SELECT request_attribution_name_valid($1) AS valid',
      [displayName],
    );
    assert.equal(valid.rows[0].valid, expected);
  }

  await pool.query(
    `UPDATE users SET display_name = CASE id
       WHEN $2 THEN $5 ELSE $6 END,
       updated_at = $4
     WHERE tenant_id = $1 AND id IN ($2, $3)`,
    [TENANT_A, REQUESTER, MANAGER, UPDATED_AT, 'Jose\u0301 山田', 'Ma\u0308rta 李'],
  );

  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUESTER, 'Requester\u200bspoof'],
  );
  await assert.rejects(
    insertRequestTransaction(pool, {
      requestId: 'invalid-requester-attribution',
      actorUserId: MANAGER,
      actorRoleAtAction: 'conference_manager',
      updatedAt: UPDATED_AT,
      suppliedRequesterName: 'Ignored requester',
      suppliedActorName: 'Ignored actor',
    }),
    (error) => error?.code === '23514'
      && error.constraint === 'requests_requester_display_valid',
  );
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUESTER, 'Jose\u0301 山田'],
  );
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, MANAGER, 'Manager\u2066spoof\u2069'],
  );
  await assert.rejects(
    insertRequestTransaction(pool, {
      requestId: 'invalid-actor-attribution',
      actorUserId: MANAGER,
      actorRoleAtAction: 'conference_manager',
      updatedAt: UPDATED_AT,
      suppliedRequesterName: 'Ignored requester',
      suppliedActorName: 'Ignored actor',
    }),
    (error) => error?.code === '23514'
      && error.constraint === 'request_revisions_actor_display_valid',
  );
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, MANAGER, 'Ma\u0308rta 李'],
  );

  await insertRequestTransaction(pool, {
    requestId: 'post-cutover-attribution',
    actorUserId: REQUESTER,
    actorRoleAtAction: 'employee',
    updatedAt: UPDATED_AT,
    suppliedRequesterName: 'Spoofed requester',
    suppliedActorName: 'Spoofed actor',
  });

  const postCutover = await pool.query(
    `SELECT request.requester_display_name, revision.actor_display_name,
            revision.actor_role_at_action
     FROM requests request
     JOIN request_revisions revision
       ON revision.tenant_id = request.tenant_id AND revision.request_id = request.id
     WHERE request.tenant_id = $1 AND request.id = 'post-cutover-attribution'`,
    [TENANT_A],
  );
  assert.deepEqual(postCutover.rows[0], {
    requester_display_name: 'José 山田',
    actor_display_name: 'José 山田',
    actor_role_at_action: 'employee',
  });

  await pool.query({
    text: `
      INSERT INTO booking_change_requests (
        tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
        internal_participants, external_participants, base_request_updated_at,
        request_schema_version, base_request_version, request_draft,
        proposed_request_snapshot, decided_by_user_id, rejection_reason, created_at, updated_at,
        initiator_role_at_action, initiator_display_name,
        decider_role_at_action, decider_display_name
      ) VALUES (
        $1, $2, 'post-cutover-attribution', $3, 'rejected', 'room-a', $4, $5,
        2, 0, $6, 1, 1, NULL, NULL, $3, 'Self decided', $6, $6,
        'conference_manager', 'Spoofed initiator', 'conference_manager', 'Spoofed decider'
      )
    `,
    values: [TENANT_A, SELF_CHANGE, MANAGER, STARTS_AT, ENDS_AT, UPDATED_AT],
  });
  const selfChange = await pool.query(
    `SELECT initiator_display_name, initiator_role_at_action,
            decider_display_name, decider_role_at_action
     FROM booking_change_requests WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, SELF_CHANGE],
  );
  assert.deepEqual(selfChange.rows[0], {
    initiator_display_name: 'Märta 李',
    initiator_role_at_action: 'conference_manager',
    decider_display_name: 'Märta 李',
    decider_role_at_action: 'conference_manager',
  });

  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUESTER, 'Initiator\u200fspoof'],
  );
  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO booking_change_requests (
          tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
          internal_participants, external_participants, base_request_updated_at,
          request_schema_version, base_request_version, request_draft,
          proposed_request_snapshot, created_at, updated_at, initiator_role_at_action
        ) VALUES (
          $1, $2, 'post-cutover-attribution', $3, 'pending', 'room-a', $4, $5,
          2, 0, $6, 1, 1, NULL, NULL, $6, $6, 'employee'
        )
      `,
      values: [TENANT_A, BAD_INITIATOR_CHANGE, REQUESTER, STARTS_AT, ENDS_AT, UPDATED_AT],
    }),
    (error) => error?.code === '23514'
      && error.constraint === 'booking_changes_initiator_display_valid',
  );
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, REQUESTER, 'Jose\u0301 山田'],
  );

  await pool.query({
    text: `
      INSERT INTO booking_change_requests (
        tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
        internal_participants, external_participants, base_request_updated_at,
        request_schema_version, base_request_version, request_draft,
        proposed_request_snapshot, created_at, updated_at, initiator_role_at_action
      ) VALUES (
        $1, $2, 'post-cutover-attribution', $3, 'pending', 'room-a', $4, $5,
        2, 0, $6, 1, 1, NULL, NULL, $6, $6, 'employee'
      )
    `,
    values: [TENANT_A, RETRY_CHANGE, REQUESTER, STARTS_AT, ENDS_AT, UPDATED_AT],
  });
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, MANAGER, 'Decider\u2068spoof\u2069'],
  );
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests
       SET status = 'applying', decided_by_user_id = $3,
           decider_role_at_action = 'conference_manager', updated_at = $4
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, RETRY_CHANGE, MANAGER, UPDATED_AT],
    ),
    (error) => error?.code === '23514'
      && error.constraint === 'booking_changes_decider_display_valid',
  );
  await pool.query(
    'UPDATE users SET display_name = $3 WHERE tenant_id = $1 AND id = $2',
    [TENANT_A, MANAGER, 'Ma\u0308rta 李'],
  );
  await pool.query(
    `UPDATE booking_change_requests
     SET status = 'applying', decided_by_user_id = $3,
         decider_role_at_action = 'conference_manager', updated_at = $4
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, RETRY_CHANGE, MANAGER, UPDATED_AT],
  );
  await pool.query(
    `UPDATE booking_change_requests
     SET status = 'pending', decided_by_user_id = NULL, updated_at = $3
     WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, RETRY_CHANGE, UPDATED_AT],
  );
  const returnedPending = await pool.query(
    `SELECT decider_display_name, decider_role_at_action
     FROM booking_change_requests WHERE tenant_id = $1 AND id = $2`,
    [TENANT_A, RETRY_CHANGE],
  );
  assert.deepEqual(returnedPending.rows[0], {
    decider_display_name: null,
    decider_role_at_action: null,
  });

  await pool.query(
    `UPDATE users SET display_name = 'Later profile name', active = FALSE, updated_at = $2
     WHERE tenant_id = $1 AND id IN ($3, $4)`,
    [TENANT_A, '2026-08-27T10:00:00.000Z', REQUESTER, MANAGER],
  );
  const unchanged = await pool.query(
    `SELECT requester_display_name FROM requests
     WHERE tenant_id = $1 AND id = 'post-cutover-attribution'`,
    [TENANT_A],
  );
  assert.equal(unchanged.rows[0].requester_display_name, 'José 山田');

  await assert.rejects(
    pool.query(
      `UPDATE requests SET requester_display_name = 'Rewritten'
       WHERE tenant_id = $1 AND id = 'post-cutover-attribution'`,
      [TENANT_A],
    ),
    /REQUEST_ATTRIBUTION_IMMUTABLE/,
  );
  await assert.rejects(
    pool.query(
      `UPDATE booking_change_requests SET initiator_role_at_action = 'employee'
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT_A, SELF_CHANGE],
    ),
    /BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE/,
  );
  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO request_revisions (
          tenant_id, request_id, request_version, schema_version, operation,
          record, captured_at, actor_user_id, correlation_id
        ) VALUES ($1, 'post-cutover-attribution', 2, 1, 'transitioned', $2::jsonb, $3, $4, $5)
      `,
      values: [
        TENANT_A,
        JSON.stringify(publicLegacyRequest(
          'post-cutover-attribution', 2, 'Confirmed', UPDATED_AT,
        )),
        UPDATED_AT,
        REQUESTER,
        CORRELATION,
      ],
    }),
    (error) => error?.code === '23514' && /REQUEST_ACTOR_ROLE_REQUIRED/.test(error.message),
  );
  await assert.rejects(
    pool.query({
      text: `
        INSERT INTO booking_change_requests (
          tenant_id, id, request_id, initiator_user_id, status, room_id, starts_at, ends_at,
          internal_participants, external_participants, base_request_updated_at,
          request_schema_version, base_request_version, request_draft,
          proposed_request_snapshot, created_at, updated_at
        ) VALUES (
          $1, $2, 'post-cutover-attribution', $3, 'pending', 'room-a', $4, $5,
          2, 0, $6, 1, 1, NULL, NULL, $6, $6
        )
      `,
      values: [TENANT_A, MISSING_ROLE_CHANGE, REQUESTER, STARTS_AT, ENDS_AT, UPDATED_AT],
    }),
    (error) => error?.code === '23514' && /BOOKING_CHANGE_ACTOR_ROLE_REQUIRED/.test(error.message),
  );

  await assert.rejects(
    rollbackToVersion(pool, 36),
    (error) => error?.code === '55000'
      && /REQUEST_ATTRIBUTION_ROLLBACK_REQUIRES_REVIEW/.test(error.message),
  );
  assert.equal(await tableHasColumn(pool, 'requests', 'requester_display_name'), true);
  // The failed inclusive rollback retains migration 036 but has already removed additive 038 and 037.
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
});
