import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBookingChangeService } from '../src/application/booking-change-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS, normalizeAuditEvent } from '../src/audit/event.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { loadDatabaseConfig } from '../src/config.js';
import { RequestCompositionUnavailableError } from '../src/domain/request-composition.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresBookingChangeRepository } from '../src/persistence/postgres/booking-change-repository.js';
import { createPostgresMicrosoft365CalendarAuthorityGuard } from '../src/persistence/postgres/calendar-authority-guard.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresRequestRepository } from '../src/persistence/postgres/request-repository.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const TENANT = '96111111-1111-4111-8111-111111111111';
const FOREIGN_TENANT = '96222222-2222-4222-8222-222222222222';
const USER = '96333333-3333-4333-8333-333333333333';
const CREATED_AT = new Date('2026-08-27T09:00:00.000Z');

function draft(overrides = {}) {
  return {
    title: 'Equipment selection', roomId: 'room-a',
    startsAt: '2026-09-03T09:00:00.000Z', endsAt: '2026-09-03T10:00:00.000Z',
    internalParticipants: 2, externalParticipants: 0,
    serviceIds: [], equipmentIds: ['display'],
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null, specialRequirements: null, allocations: [],
    configurationRevisions: { organization: 1, locations: 1, catalogue: 2, bookingPolicies: 1, costAllocation: 1 },
    ...overrides,
  };
}

function audit(requestId, action = AUDIT_ACTION.REQUEST_CREATED, operation = 'request_create', occurredAt = CREATED_AT) {
  return normalizeAuditEvent({
    tenantId: TENANT, actorUserId: USER, action, targetType: 'request', targetId: requestId,
    previousState: null, newState: null, occurredAt: occurredAt.toISOString(), correlationId: randomUUID(),
    outcome: AUDIT_OUTCOME.SUCCESS, metadata: { operation }, retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
  });
}

async function seed(pool) {
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Equipment A','active'),($2,'Equipment B','active')",
    [TENANT, FOREIGN_TENANT]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Equipment owner')", [TENANT, USER]);
  await pool.query(`INSERT INTO sites(tenant_id,id,name,time_zone)
    VALUES($1,'site-a','Site A','Europe/Berlin'),($1,'site-b','Site B','Europe/Berlin')`, [TENANT]);
  await pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity)
    VALUES($1,'room-a','site-a','Room A',20),($1,'room-b','site-b','Room B',20)`, [TENANT]);
  await pool.query(`INSERT INTO tenant_room_prices(tenant_id,room_id,price_minor,currency)
    VALUES($1,'room-a',1000,'EUR'),($1,'room-b',1000,'EUR')`, [TENANT]);
  await pool.query(`INSERT INTO equipment(tenant_id,id,name,description,active,price_minor,currency,sort_order) VALUES
    ($1,'display','Original display','Immutable description',true,2500,'EUR',1),
    ($1,'inactive','Retired equipment',NULL,false,500,'EUR',2),
    ($1,'wrong-site','Site B only',NULL,true,500,'EUR',3),
    ($1,'wrong-room','Room B only',NULL,true,500,'EUR',4),
    ($1,'usd','USD equipment',NULL,true,500,'USD',5),
    ($2,'display','Foreign display',NULL,true,9999,'USD',1),
    ($2,'foreign-only','Foreign equipment',NULL,true,700,'EUR',2)`, [TENANT, FOREIGN_TENANT]);
  await pool.query(`INSERT INTO equipment_site_applicability(tenant_id,equipment_id,site_id)
    VALUES($1,'wrong-site','site-b'),($1,'display','site-a')`, [TENANT]);
  await pool.query(`INSERT INTO equipment_room_applicability(tenant_id,equipment_id,room_id)
    VALUES($1,'wrong-room','room-b'),($1,'display','room-a')`, [TENANT]);
}

test('Request v3 equipment persists, changes, rolls back and preserves exact v2 compatibility', async (t) => {
  const pool = createPostgresPool({ mode: 'test', ...loadDatabaseConfig(process.env, 'test') });
  t.after(() => pool.end());
  await migrateUp(pool);
  await migrateUp(pool);
  await seed(pool);
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'equipment-v3-integration-audit-key-32' });
  const requests = createPostgresRequestRepository(pool, {
    auditRepository, calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });
  const changes = createPostgresBookingChangeRepository(pool, { auditRepository });
  const create = (id, requestDraft = draft(), repository = requests, schemaVersion = 3) => (
    repository.createVersionedForTenant({
      tenantId: TENANT, requestId: id, requesterUserId: USER, schemaVersion, requestDraft,
      createdAt: CREATED_AT, auditEvent: audit(id),
    })
  );
  const transition = (id, expectedStatus, nextStatus, minute = 1) => requests.transitionByTenantIdAndId({
    tenantId: TENANT, requestId: id, actorUserId: USER, expectedStatus, nextStatus,
    reason: nextStatus === 'Change Requested' ? 'Please revise' : null,
    changedAt: new Date(CREATED_AT.getTime() + minute * 60000),
    auditEvent: audit(id, AUDIT_ACTION.REQUEST_TRANSITION, 'transition'),
  });

  const created = await create('v3-request');
  assert.equal(created.status, 'created');
  assert.equal(created.request.schemaVersion, 3);
  assert.deepEqual(created.request.snapshot.details.equipmentIds, ['display']);
  assert.equal(created.request.snapshot.pricing.equipment[0].equipment.name, 'Original display');
  assert.equal(created.request.snapshot.pricing.breakdown.equipmentMinor, 2500);
  assert.equal(created.request.snapshot.pricing.totalMinor, 3500);
  assert.equal(created.request.snapshot.allocations.unallocatedMinor, 3500);
  assert.equal(await requests.findByTenantIdAndId(FOREIGN_TENANT, 'v3-request'), null);

  const initialCounts = (await pool.query(`SELECT
    (SELECT count(*) FROM requests) AS requests,
    (SELECT count(*) FROM request_revisions) AS revisions,
    (SELECT count(*) FROM audit_events) AS audits`)).rows[0];
  for (const id of ['missing', 'inactive', 'foreign-only', 'wrong-site', 'wrong-room']) {
    await assert.rejects(create(`invalid-${id}`, draft({ equipmentIds: [id] })), RequestCompositionUnavailableError);
  }
  await assert.rejects(create('mixed-currency', draft({ equipmentIds: ['usd'] })), { code: 'REQUEST_MIXED_CURRENCY' });
  assert.equal((await create('stale', draft({
    configurationRevisions: { ...draft().configurationRevisions, catalogue: 99 },
  }))).status, 'configuration_conflict');
  const failing = createPostgresRequestRepository(pool, {
    auditRepository: { async appendWithClient() { throw new Error('AUDIT_TEST_FAILURE'); } },
    calendarAuthorityGuard: createPostgresMicrosoft365CalendarAuthorityGuard(),
  });
  await assert.rejects(create('audit-failure', draft(), failing), /AUDIT_TEST_FAILURE/);
  assert.deepEqual((await pool.query(`SELECT
    (SELECT count(*) FROM requests) AS requests,
    (SELECT count(*) FROM request_revisions) AS revisions,
    (SELECT count(*) FROM audit_events) AS audits`)).rows[0], initialCounts);

  await pool.query("UPDATE equipment SET name='Current display',price_minor=3000 WHERE tenant_id=$1 AND id='display'", [TENANT]);
  assert.equal((await requests.findByTenantIdAndId(TENANT, 'v3-request')).snapshot.pricing.totalMinor, 3500);
  const revised = await transition('v3-request', 'Submitted', 'Change Requested');
  assert.equal(revised.snapshot.requestVersion, 2);
  const resubmit = (title) => requests.resubmitVersionedForTenant({
    tenantId: TENANT, requestId: 'v3-request', requesterUserId: USER, schemaVersion: 3,
    expectedVersion: 2, requestDraft: draft({ title }), changedAt: new Date(CREATED_AT.getTime() + 120000),
    auditEvent: audit('v3-request'),
  });
  const concurrent = await Promise.all([resubmit('First title'), resubmit('Second title')]);
  assert.deepEqual(concurrent.map((value) => value.status).sort(), ['resubmitted', 'state_conflict']);
  const latest = await requests.findByTenantIdAndId(TENANT, 'v3-request');
  assert.equal(latest.snapshot.pricing.totalMinor, 4000);
  const history = await requests.listHistoryPageByTenantIdAndId(TENANT, 'v3-request', {
    asOfVersion: 3, beforeVersion: null, limit: 11,
  });
  assert.deepEqual(history.map((entry) => entry.request.pricing.totalMinor), [4000, 3500, 3500]);
  await transition('v3-request', 'Submitted', 'Confirmed', 3);

  const policy = createAuthorizationPolicy();
  const manager = { tenantId: TENANT, userId: USER, ...tenantAuthorizationSnapshot(['conference_manager']), securityVersion: 1 };
  const context = { tenantId: TENANT, status: 'active' };
  const service = createBookingChangeService({
    repository: changes, requestRepository: requests, authorizationPolicy: policy,
    auditService: createAuditService({ repository: auditRepository, authorizationPolicy: policy }),
    bookingServiceFactory: {
      async forRequest() { throw new Error('UNEXPECTED_CALENDAR_LOOKUP'); },
      async moveCalendarEvent() { throw new Error('UNEXPECTED_CALENDAR_MOVE'); },
      async rollbackCalendarMove() { throw new Error('UNEXPECTED_CALENDAR_ROLLBACK'); },
    },
    clock: () => CREATED_AT.getTime() + 240000,
  });
  const propose = (proposal, expectedVersion, schemaVersion = 3) => service.propose({
    principal: manager, tenantContext: context, correlationId: randomUUID(), requestId: 'v3-request',
    schemaVersion, expectedVersion, proposed: proposal,
  });
  const currentDraft = draft({ title: latest.snapshot.details.title });
  await assert.rejects(propose(currentDraft, 4), { code: 'BOOKING_CHANGE_EMPTY' });
  const direct = await propose({ ...currentDraft, internalParticipants: 3 }, 4);
  assert.equal(direct.change.status, 'applied');
  assert.equal(direct.change.requestSchemaVersion, 3);
  assert.equal(direct.requestRef.version, 5);
  const pending = await propose({ ...currentDraft, internalParticipants: 3, equipmentIds: [] }, 5);
  assert.equal(pending.change.status, 'pending');
  assert.deepEqual(pending.change.proposedRequest.details.equipmentIds, []);
  assert.deepEqual((await requests.findByTenantIdAndId(TENANT, 'v3-request')).snapshot.details.equipmentIds, ['display']);
  const approved = await service.approve({
    principal: manager, tenantContext: context, correlationId: randomUUID(), requestId: 'v3-request',
    changeId: pending.change.id,
  });
  assert.equal(approved.change.status, 'applied');
  assert.equal(approved.requestRef.version, 6);
  assert.equal(approved.change.proposedRequest.pricing.breakdown.equipmentMinor, 0);
  const rejected = await propose({ ...currentDraft, internalParticipants: 3 }, 6);
  await service.reject({ principal: manager, tenantContext: context, correlationId: randomUUID(),
    requestId: 'v3-request', changeId: rejected.change.id, rejectionReason: 'No equipment required' });
  assert.deepEqual((await requests.findByTenantIdAndId(TENANT, 'v3-request')).snapshot.details.equipmentIds, []);

  const { equipmentIds, ...v2 } = draft();
  assert.equal(equipmentIds.length, 1);
  const old = await create('v2-request', v2, requests, 2);
  assert.equal(old.request.schemaVersion, 2);
  assert.equal('equipment' in old.request.snapshot.pricing, false);
  await assert.rejects(create('hybrid-v2', draft(), requests, 2));

  const snapshot = created.request.snapshot;
  const mutations = [
    (value) => { value.pricing.equipment[0].equipment.name = null; },
    (value) => { delete value.pricing.equipment[0].equipment.description; },
    (value) => { value.pricing.equipment[0].quantity = 2; },
    (value) => { value.pricing.equipment[0].lineTotalMinor = -1; },
    (value) => { value.pricing.equipment[0].equipment.price.amountMinor = '2500'; },
    (value) => { value.pricing.breakdown.equipmentMinor = 0; },
    (value) => { value.details.equipmentIds = ['display', 'display']; },
    (value) => { value.details.equipmentIds = Array(201).fill('display'); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    assert.equal((await pool.query('SELECT request_equipment_snapshot_valid(3,$1::jsonb,$2::jsonb) AS valid',
      [JSON.stringify(invalid.details), JSON.stringify(invalid.pricing)])).rows[0].valid, false);
  }
  const down = await readFile('migrations/035_request_composition_v3_equipment_selection.down.sql', 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query(down), /REQUEST_COMPOSITION_V3_ROLLBACK_REQUIRES_REVIEW/);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await requests.findByTenantIdAndId(TENANT, 'v3-request')).version, 6);
});
