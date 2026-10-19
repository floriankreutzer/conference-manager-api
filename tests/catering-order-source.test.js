import assert from 'node:assert/strict';
import test from 'node:test';
import { toPublicRequest } from '../src/domain/request.js';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { loadCateringOrderSourceWithClient, readCateringOrderWithClient } from '../src/persistence/postgres/catering-order-source.js';
import { cateringId, cateringOrderFixture } from './support/catering-order-fixture.js';

function fixture() {
  const input = cateringOrderFixture();
  const [snapshot] = createCateringOrderSnapshots(input);
  const { requesterAttribution: _attribution, ...record } = toPublicRequest(input.request);
  const sourceRow = { tenant_id: input.request.tenantId, record, requester_user_id: input.request.requesterUserId,
    requester_display_name: input.request.requesterAttribution.displayName };
  const detail = { tenant_id: snapshot.tenantId, order_id: snapshot.orderId, version: '1',
    request_id: snapshot.requestId, request_version: String(snapshot.requestVersion), integration_id: snapshot.integrationId,
    assignment_revision: '3', catalogue_revision: '4', configuration_revision: '1', operation: 'initial',
    provider: 'manual_catering', position_count: snapshot.positions.length,
    conference_total_minor: String(snapshot.conferencePrice.amountMinor), currency: 'EUR', state_revision: '1',
    status: 'pending_quote', state_updated_at: new Date('2026-10-19T10:00:00.000Z'), quote_revision: null,
    decision_sequence: null, observed_at: new Date('2026-10-19T10:00:00.000Z') };
  const data = {
    'catering-order-historical-request': [sourceRow],
    'catering-order-historical-ownership': [{ catalogue_revision: '4', snapshot: input.canonicalCatalogue }],
    'catering-order-historical-ownership-entries': input.ownership.assignments.map((entry) => ({
      kind: entry.kind, entry_id: entry.entryId, integration_id: entry.integrationId,
    })),
    'catering-order-detail-read': [detail],
    'catering-order-persisted-positions': snapshot.positions.map((entry) => ({
      position_id: entry.positionId, kind: entry.kind, entry_id: entry.entryId,
    })),
  };
  const queries = [];
  const client = { async query(query) {
    queries.push(query);
    assert.equal(query.values[0], input.request.tenantId);
    assert.ok(Object.hasOwn(data, query.name), query.name);
    return { rowCount: data[query.name].length, rows: data[query.name] };
  } };
  return { input, snapshot, data, detail, sourceRow, client, queries };
}

test('persisted order detail reconstructs exact immutable source and identities without requester data', async () => {
  const f = fixture();
  const result = await readCateringOrderWithClient(f.client, { tenantId: f.snapshot.tenantId, orderId: f.snapshot.orderId,
    registry: createCateringConfigurationRegistry() });
  assert.deepEqual(result.snapshot, f.snapshot);
  assert.equal(result.providerId, 'manual_catering');
  assert.equal(result.state.status, 'pending_quote');
  assert.equal(result.quote, null);
  assert.equal(result.decision, null);
  assert.equal(Object.hasOwn(result.snapshot, 'requesterAttribution'), false);
  assert.equal(Object.hasOwn(result.snapshot, 'requesterUserId'), false);
  assert.ok(f.queries.every((query) => query.text.includes('tenant_id=$1')));
});

test('metadata/source scope, version, position identity and historical price corruption fail closed', async () => {
  for (const mutate of [
    (f) => { f.detail.tenant_id = cateringId(9); },
    (f) => { f.detail.order_id = cateringId(9); },
    (f) => { f.sourceRow.tenant_id = cateringId(9); },
    (f) => { f.sourceRow.record.id = 'different-request'; },
    (f) => { f.data['catering-order-persisted-positions'][0].position_id = f.snapshot.orderId; },
    (f) => { f.data['catering-order-persisted-positions'][0].entry_id = 'other-entry'; },
    (f) => { f.detail.conference_total_minor = '901'; },
    (f) => { f.detail.status = 'delivered'; },
    (f) => { f.detail.operation = 'automatic'; },
    (f) => { f.data['catering-order-historical-ownership'][0].snapshot.cateringItems[0].price.amountMinor++; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readCateringOrderWithClient(f.client, { tenantId: f.snapshot.tenantId, orderId: f.snapshot.orderId,
      registry: createCateringConfigurationRegistry() }));
  }
});

test('missing history/ownership never falls back to current Tenant catalogue or an invented source', async () => {
  for (const missing of ['catering-order-historical-request','catering-order-historical-ownership']) {
    const f = fixture(); f.data[missing] = [];
    const source = await loadCateringOrderSourceWithClient(f.client, { tenantId: f.snapshot.tenantId,
      requestId: f.snapshot.requestId, requestVersion: 2, assignmentRevision: 3 });
    assert.equal(source, null);
    assert.ok(f.queries.every((query) => !query.text.includes('catalog_revision')));
  }
});
