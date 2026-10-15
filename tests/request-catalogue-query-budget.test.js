import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCurrentRequestCompositionWithClient } from '../src/persistence/postgres/request-repository.js';
import { DEFAULT_TENANT_BOOKING_POLICIES } from '../src/domain/tenant-booking-policies.js';
import { requestLoadDraft } from './support/request-load-draft.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorUserId = '22222222-2222-4222-8222-222222222222';
const selectorNames = ['request-v2-authority-services', 'request-v2-authority-catering-items', 'request-v3-authority-equipment'];
function entry(id) {
  return { id, name: id, description: null, price_minor: 100, currency: 'EUR', active: true,
    sort_order: 0, site_ids: [], room_ids: [] };
}
function fixture({ missing = null, inactive = null, inapplicable = null, packageItems = [] } = {}) {
  const calls = [];
  const client = { async query(query) {
    calls.push(query);
    assert.equal(query.values[0], tenantId);
    switch (query.name) {
      case 'request-v2-authority-tenant-lock':
        assert.equal(query.values[1], actorUserId);
        return { rows: [{ organization_revision: 1, locations_revision: 1, catalog_revision: 1,
          booking_policies_revision: 1, cost_allocation_revision: 1, default_currency: 'EUR' }] };
      case 'request-v2-authority-room':
        return { rows: [{ id: 'room', site_id: 'site', name: 'Room', capacity: 20, room_active: true,
          site_active: true, time_zone: 'Europe/Berlin', price_minor: 1000, currency: 'EUR' }] };
      case 'request-v2-authority-booking-policy': return { rows: [{ configuration: DEFAULT_TENANT_BOOKING_POLICIES }] };
      case 'request-v2-authority-allocation-configuration': return { rows: [{ allocation_required: false }] };
      case 'request-v2-authority-allocation-centers': return { rows: [] };
      case 'request-v2-authority-package': return { rows: [{ ...entry('package'), item_ids: packageItems }] };
      case 'request-v2-authority-package-variant': return { rows: [entry('variant')] };
      default:
        assert.ok(selectorNames.includes(query.name), 'Only existing authoritative selectors may execute');
        assert.ok(query.values[1].length > 0, 'Empty selections must perform no SQL');
        assert.match(query.text, /tenant_id = \$1/); assert.match(query.text, /FOR SHARE OF/);
        return { rows: query.values[1].filter(id => id !== missing).map(id => ({ ...entry(id),
          ...(id === inactive ? { active: false } : {}), ...(id === inapplicable ? { room_ids: ['other-room'] } : {}) })) };
    }
  } };
  return { calls, client };
}
function resolve(client, draft, schemaVersion = 3) {
  return resolveCurrentRequestCompositionWithClient(client, { tenantId, actorUserId, draft, schemaVersion,
    operation: 'create', capturedAt: '2026-10-15T09:00:00.000Z', requestVersion: 1 });
}

test('empty v2/v3 selections skip only known-empty catalogue reads and retain authoritative evaluation', async () => {
  for (const schemaVersion of [2, 3]) {
    const { client, calls } = fixture(); const draft = requestLoadDraft();
    if (schemaVersion === 2) delete draft.equipmentIds;
    const result = await resolve(client, draft, schemaVersion);
    assert.equal(result.status, 'ready'); assert.equal(result.snapshot.pricing.totalMinor, 1000);
    assert.deepEqual(calls.map(x => x.name), ['request-v2-authority-tenant-lock', 'request-v2-authority-room',
      'request-v2-authority-booking-policy', 'request-v2-authority-allocation-configuration',
      'request-v2-authority-allocation-centers']);
  }
});

test('every selected category still resolves exact tenant-scoped IDs, price and availability', async () => {
  for (let mask = 1; mask < 8; mask += 1) {
    const draft = requestLoadDraft();
    if (mask & 1) draft.serviceIds = ['service'];
    if (mask & 2) draft.catering = { participantCount: 1, packageSelection: null,
      itemQuantities: [{ itemId: 'item', quantity: 2 }] };
    if (mask & 4) draft.equipmentIds = ['equipment'];
    const { client, calls } = fixture(); const result = await resolve(client, draft);
    assert.equal(result.status, 'ready');
    assert.equal(result.snapshot.pricing.totalMinor, 1000 + (mask & 1 ? 100 : 0) + (mask & 2 ? 200 : 0) + (mask & 4 ? 100 : 0));
    assert.deepEqual(calls.filter(x => selectorNames.includes(x.name)).map(x => x.values[1]),
      [...(mask & 1 ? [['service']] : []), ...(mask & 2 ? [['item']] : []), ...(mask & 4 ? [['equipment']] : [])]);
    for (const id of [...draft.serviceIds, ...draft.equipmentIds, ...draft.catering.itemQuantities.map(x => x.itemId)]) {
      for (const failure of ['missing', 'inactive', 'inapplicable']) {
        await assert.rejects(resolve(fixture({ [failure]: id }).client, draft), /REQUEST_CONFIGURATION_UNAVAILABLE/);
      }
    }
  }
});

test('package-included items still resolve with no direct selection, including missing/inactive denial', async () => {
  const draft = requestLoadDraft();
  draft.catering = { participantCount: 1, packageSelection: { packageId: 'package', variantId: 'variant' }, itemQuantities: [] };
  const { client, calls } = fixture({ packageItems: ['included'] }); const result = await resolve(client, draft);
  assert.equal(result.status, 'ready'); assert.equal(result.snapshot.pricing.totalMinor, 1100);
  assert.deepEqual(calls.find(x => x.name === 'request-v2-authority-catering-items').values, [tenantId, ['included']]);
  for (const failure of ['missing', 'inactive', 'inapplicable']) {
    await assert.rejects(resolve(fixture({ packageItems: ['included'], [failure]: 'included' }).client, draft),
      failure === 'inapplicable' ? /REQUEST_CONFIGURATION_UNAVAILABLE/ : /TENANT_CATALOGUE_PACKAGE_ITEM_REFERENCE_INVALID/);
  }
});
