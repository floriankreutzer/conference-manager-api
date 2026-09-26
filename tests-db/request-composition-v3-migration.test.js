import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createRequestCompositionSnapshot } from '../src/domain/request-composition.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';

const TENANT = '97111111-1111-4111-8111-111111111111';
const USER = '97222222-2222-4222-8222-222222222222';
const AT = '2026-08-27T09:00:00.000Z';
function draft(schemaVersion) {
  return {
    title: 'Retained composition', roomId: 'room',
    startsAt: '2026-09-03T09:00:00.000Z', endsAt: '2026-09-03T10:00:00.000Z',
    internalParticipants: 2, externalParticipants: 0, serviceIds: [],
    ...(schemaVersion === 3 ? { equipmentIds: ['display'] } : {}),
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null, specialRequirements: null, allocations: [],
    configurationRevisions: { organization: 1, locations: 1, catalogue: 2, bookingPolicies: 1, costAllocation: 1 },
  };
}
function snapshot(schemaVersion, requestVersion) {
  const amount = schemaVersion === 3 ? 2500 : 0;
  return createRequestCompositionSnapshot({
    schemaVersion, draft: draft(schemaVersion), requestVersion, capturedAt: AT,
    room: { id: 'room', siteId: 'site', name: 'Room', price: { amountMinor: 0, currency: 'EUR' } },
    catalogueSnapshot: {
      schemaVersion: 1, catalogRevision: 2, capturedAt: AT, siteId: 'site', roomId: 'room',
      services: [], equipment: schemaVersion === 3 ? [{
        id: 'display', name: 'Retained display', description: null, price: { amountMinor: 2500, currency: 'EUR' },
      }] : [], cateringItems: [], catering: [],
    },
    bookingPolicySnapshot: {
      policyVersionId: 'policy', effectiveFrom: '2026-01-01T00:00:00.000Z', evaluatedAt: AT,
      rules: { minimumLeadTimeMinutes: 0, maximumAdvanceMinutes: 527040, cancellationWindowMinutes: 0,
        changeWindowMinutes: 0, maximumParticipants: 500, allowedSiteIds: [], allowedRoomIds: [], allowedServiceIds: [] },
    },
    allocationSnapshot: {
      schemaVersion: 1, configurationRevision: 1, snapshottedAt: AT, model: 'percentage_basis_points',
      totalBasisPoints: 0, totalMinor: amount, allocatedMinor: 0, unallocatedMinor: amount, currency: 'EUR', entries: [],
    },
    revisions: draft(schemaVersion).configurationRevisions, defaultCurrency: 'EUR',
  });
}
async function insertRequest(pool, id, schemaVersion) {
  const composed = schemaVersion === 1 ? null : snapshot(schemaVersion, 1);
  const record = {
    schemaVersion, version: 1, id, roomId: 'room', status: 'Confirmed', statusReason: null,
    startsAt: draft(2).startsAt, endsAt: draft(2).endsAt, internalParticipants: 2, externalParticipants: 0,
    statusChangedAt: AT, createdAt: AT, updatedAt: AT,
    details: composed?.details ?? null, pricing: composed?.pricing ?? null,
    configurationRevisions: composed?.configurationRevisions ?? null,
    policy: composed?.policy ?? null, allocations: composed?.allocations ?? null,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO requests(tenant_id,id,requester_user_id,room_id,status,starts_at,ends_at,
      internal_participants,external_participants,schema_version,request_version,request_snapshot,status_changed_at,created_at,updated_at)
      VALUES($1,$2,$3,'room','Confirmed',$4,$5,2,0,$6,1,$7::jsonb,$8,$8,$8)`,
    [TENANT, id, USER, record.startsAt, record.endsAt, schemaVersion,
      composed === null ? null : JSON.stringify(composed), AT]);
    const revision = await client.query(`INSERT INTO request_revisions(tenant_id,request_id,request_version,schema_version,
      operation,record,captured_at,actor_user_id,correlation_id) VALUES($1,$2,1,$3,'created',$4::jsonb,$5,$6,$7)
      RETURNING revision_sequence`, [TENANT, id, schemaVersion, JSON.stringify(record), AT, USER, randomUUID()]);
    await client.query('UPDATE requests SET current_revision_sequence=$3 WHERE tenant_id=$1 AND id=$2',
      [TENANT, id, revision.rows[0].revision_sequence]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function insertProposal(pool, requestId, schemaVersion) {
  const proposal = draft(schemaVersion);
  await pool.query(`INSERT INTO booking_change_requests(tenant_id,id,request_id,initiator_user_id,status,room_id,
    starts_at,ends_at,internal_participants,external_participants,base_request_updated_at,request_schema_version,
    base_request_version,request_draft,proposed_request_snapshot,created_at,updated_at)
    VALUES($1,$2,$3,$4,'pending','room',$5,$6,2,0,$7,$8,1,$9::jsonb,$10::jsonb,$7,$7)`,
  [TENANT, randomUUID(), requestId, USER, proposal.startsAt, proposal.endsAt, AT, schemaVersion,
    JSON.stringify(proposal), JSON.stringify(snapshot(schemaVersion, 2))]);
}
async function serializedRows(pool) {
  const result = {};
  for (const table of ['requests', 'request_revisions', 'booking_change_requests']) {
    result[table] = (await pool.query(`SELECT row_to_json(entry)::text AS record FROM ${table} entry ORDER BY 1`)).rows;
  }
  return result;
}

test('migration 035 preserves v1/v2 rows and proposals, reapplies and refuses v3 history loss', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'request-v3-migrations-'));
  const pool = createPostgresPool({ mode: 'test', ...loadDatabaseConfig(process.env, 'test') });
  t.after(async () => { await pool.end(); await rm(directory, { recursive: true, force: true }); });
  // Isolate this migration's contract from subsequent additive migrations.
  for (const filename of await readdir('migrations')) {
    if (Number(filename.slice(0, 3)) <= 34) await copyFile(path.join('migrations', filename), path.join(directory, filename));
  }
  await migrateUp(pool, directory);
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Retained tenant','active')", [TENANT]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Retained owner')", [TENANT, USER]);
  await pool.query("INSERT INTO sites(tenant_id,id,name,time_zone) VALUES($1,'site','Site','Europe/Berlin')", [TENANT]);
  await pool.query("INSERT INTO rooms(tenant_id,id,site_id,name,capacity) VALUES($1,'room','site','Room',20)", [TENANT]);
  await insertRequest(pool, 'legacy', 1);
  await insertRequest(pool, 'current-v2', 2);
  await insertRequest(pool, 'future-v3-proposal', 2);
  await insertProposal(pool, 'current-v2', 2);
  const retained = await serializedRows(pool);
  for (const direction of ['up', 'down']) {
    const filename = `035_request_composition_v3_equipment_selection.${direction}.sql`;
    await copyFile(path.join('migrations', filename), path.join(directory, filename));
  }
  await migrateUp(pool, directory);
  await migrateUp(pool, directory);
  assert.deepEqual(await serializedRows(pool), retained);
  assert.equal((await pool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0].version, 35);
  assert.equal(await rollbackLatest(pool, directory), true);
  assert.deepEqual(await serializedRows(pool), retained);
  await migrateUp(pool, directory);
  assert.deepEqual(await serializedRows(pool), retained);
  // A v3 proposal on an unchanged v2 Request must already block down; no v3 current row is required.
  await insertProposal(pool, 'future-v3-proposal', 3);
  await assert.rejects(rollbackLatest(pool, directory), /REQUEST_COMPOSITION_V3_ROLLBACK_REQUIRES_REVIEW/);
  await insertRequest(pool, 'current-v3', 3);
  const withEvidence = await serializedRows(pool);
  await assert.rejects(rollbackLatest(pool, directory), /REQUEST_COMPOSITION_V3_ROLLBACK_REQUIRES_REVIEW/);
  assert.deepEqual(await serializedRows(pool), withEvidence);
  const invalid = structuredClone(snapshot(3, 1));
  delete invalid.pricing.equipment[0].equipment.description;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query('UPDATE requests SET request_snapshot=$3::jsonb WHERE tenant_id=$1 AND id=$2',
      [TENANT, 'current-v3', JSON.stringify(invalid)]), { code: '23514' });
  } finally { await client.query('ROLLBACK'); client.release(); }
  const source = await readFile(path.join(directory, '035_request_composition_v3_equipment_selection.up.sql'), 'utf8');
  assert.equal(source.includes('UPDATE requests'), false);
});
