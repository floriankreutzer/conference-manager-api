import assert from 'node:assert/strict';
import test from 'node:test';
import { CATERING_MAX_ORDER_POSITIONS, createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { cateringId, cateringOrderFixture } from './support/catering-order-fixture.js';

test('each provider receives independent immutable commercial positions and its exact conference-price share', () => {
  for (const schemaVersion of [2, 3]) {
    const input = cateringOrderFixture({ schemaVersion });
    const before = JSON.stringify(input);
    const orders = createCateringOrderSnapshots(input);
    assert.equal(orders.length, 2);
    assert.equal(orders[0].integrationId, cateringId(3));
    assert.equal(orders[1].integrationId, cateringId(4));
    assert.notEqual(orders[0].orderId, orders[1].orderId);
    assert.equal(orders[0].positions.length, 1);
    assert.equal(orders[0].positions[0].kind, 'package');
    assert.equal(orders[0].positions[0].packageDetails.includedItems.length, 2);
    assert.deepEqual(orders[0].positions[0].packageDetails.includedSelections, [{ itemId: 'included-0', quantity: 2 }]);
    assert.deepEqual(orders[0].conferencePrice, { amountMinor: 900, currency: 'EUR' });
    assert.deepEqual(orders[1].conferencePrice, { amountMinor: 200, currency: 'EUR' });
    assert.equal(orders[0].providerCost, null);
    assert.equal(orders[1].providerCost, null);
    for (const order of orders) assert.deepEqual([order.requestId, order.requestVersion, order.orderVersion,
      order.assignmentRevision, order.catalogueRevision], ['request-a', 2, 1, 3, 4]);
    assert.equal(JSON.stringify(input), before);
    input.canonicalCatalogue.cateringItems[0].name = 'Changed later';
    assert.equal(orders[0].positions[0].packageDetails.includedItems[0].name, 'included-0');
    assert.throws(() => { orders[0].providerCost = { amountMinor: 1, currency: 'EUR' }; }, TypeError);
  }
});

test('full direct-selection capacity plus package preserves 101 positions and legitimate aggregate totals', () => {
  const input = cateringOrderFixture({ includedCount: 200, extraCount: 100, includedSelection: false,
    quantity: 1000, participants: 500, unitPrice: 1000000000, packagePrice: 1000000000 });
  // Put all selected offers in one connection to exercise the per-order maximum.
  for (const entry of input.ownership.assignments) entry.integrationId = cateringId(3);
  const orders = createCateringOrderSnapshots(input);
  assert.equal(CATERING_MAX_ORDER_POSITIONS, 101);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].positions.length, 101);
  assert.equal(orders[0].positions[0].packageDetails.includedItems.length, 200);
  assert.equal(orders[0].conferencePrice.amountMinor, 100500000000000);
});

test('all 300 package components survive without fabricating extra charges or positions', () => {
  const input = cateringOrderFixture({ includedCount: 300, extraCount: 0 });
  const [order] = createCateringOrderSnapshots(input);
  assert.equal(order.positions.length, 1);
  assert.equal(order.positions[0].packageDetails.includedItems.length, 300);
  assert.equal(order.conferencePrice.amountMinor, 900);
});

test('stale ownership, foreign connections, split packages and mismatched historical catalogue fail closed', () => {
  for (const mutate of [
    (v) => { v.ownership.catalogueRevision = 5; },
    (v) => { v.connections[0].tenantId = cateringId(99); },
    (v) => { v.ownership.assignments[0].integrationId = cateringId(4); },
    (v) => { v.ownership.assignments.pop(); },
    (v) => { v.canonicalCatalogue.cateringItems[0].price.amountMinor++; },
    (v) => { v.canonicalCatalogue.cateringPackages[0].variants[0].price.amountMinor++; },
    (v) => { v.canonicalCatalogue.cateringPackages[0].itemIds.pop(); },
    (v) => { v.assignmentRevision = 0; },
    (v) => { v.request.status = 'Submitted'; },
  ]) {
    const value = cateringOrderFixture(); mutate(value);
    assert.throws(() => createCateringOrderSnapshots(value));
  }
});

test('server identifier factories must produce distinct internal identities; no failed projection dispatches', () => {
  for (const factory of [() => 'external', () => cateringId(99)]) {
    const input = cateringOrderFixture();
    input.positionIdFactory = factory;
    assert.throws(() => createCateringOrderSnapshots(input), /SNAPSHOT_INVALID/);
  }
  const input = cateringOrderFixture(); input.orderIdFactory = () => cateringId(100);
  assert.throws(() => createCateringOrderSnapshots(input), /SNAPSHOT_INVALID/);
});

test('shared commercial-selection failures retain the exact order error consumed by persisted version-proposal fallback', () => {
  for (const change of [
    value => { value.canonicalCatalogue.cateringItems[0].price.amountMinor++; },
    value => { value.canonicalCatalogue.cateringPackages[0].variants[0].description='Changed meal'; },
    value => { value.canonicalCatalogue.cateringPackages[0].itemIds.pop(); },
  ]) {
    const value=cateringOrderFixture(); change(value);
    assert.throws(()=>createCateringOrderSnapshots(value),{name:'TypeError',message:'CATERING_ORDER_SNAPSHOT_INVALID'});
  }
});
