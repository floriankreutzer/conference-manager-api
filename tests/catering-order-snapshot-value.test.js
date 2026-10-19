import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { normalizeCateringOrderSnapshot } from '../src/domain/catering-order-snapshot-value.js';
import { cateringId, cateringOrderFixture } from './support/catering-order-fixture.js';

function fixture() {
  const [snapshot] = createCateringOrderSnapshots(cateringOrderFixture());
  return { snapshot, expected: { tenantId: snapshot.tenantId, orderId: snapshot.orderId } };
}
test('closed order snapshot values preserve exact source content, arithmetic and immutable package components', () => {
  const f = fixture();
  const value = normalizeCateringOrderSnapshot(f.snapshot, f.expected);
  assert.deepEqual(value, f.snapshot);
  assert.equal(Object.isFrozen(value.positions[0].packageDetails.includedItems[0]), true);
  const input = cateringOrderFixture({ includedCount: 200, extraCount: 100, includedSelection: false,
    quantity: 1000, participants: 500, unitPrice: 1000000000, packagePrice: 1000000000 });
  for (const entry of input.ownership.assignments) entry.integrationId = cateringId(3);
  const [maximum] = createCateringOrderSnapshots(input);
  assert.equal(normalizeCateringOrderSnapshot(maximum, { tenantId: maximum.tenantId, orderId: maximum.orderId }).positions.length, 101);
});
test('scope swaps, invented supplier cost, extra keys, arithmetic/quantity and incomplete package selections fail closed', () => {
  for (const mutate of [
    (v) => { v.tenantId = cateringId(99); }, (v) => { v.orderId = cateringId(99); },
    (v) => { v.providerCost = { amountMinor: 1, currency: 'EUR' }; }, (v) => { v.status = 'confirmed'; },
    (v) => { v.positions[0].unitPrice.amountMinor++; }, (v) => { v.conferencePrice.amountMinor++; },
    (v) => { v.positions[0].quantity++; }, (v) => { v.participantCount++; },
    (v) => { v.positions[0].positionId = v.orderId; }, (v) => { v.positions[0].approved = true; },
    (v) => { v.positions[0].packageDetails.includedSelections[0].itemId = 'foreign-item'; },
    (v) => { v.positions[0].packageDetails.variant.price.amountMinor++; },
    (v) => { v.endsAt = v.startsAt; }, (v) => { v.startsAt = 'tomorrow'; },
    (v) => { delete v.positions[0]; }, (v) => { v.positions.extra = true; },
  ]) {
    const f = fixture(); const value = structuredClone(f.snapshot); mutate(value);
    assert.throws(() => normalizeCateringOrderSnapshot(value, f.expected));
  }
});
test('accessors, hidden and symbol fields cannot participate in order-value validation', () => {
  const f = fixture();
  let reads = 0;
  const value = structuredClone(f.snapshot);
  Object.defineProperty(value.positions, '0', { enumerable: true, get() { reads++; return f.snapshot.positions[0]; } });
  assert.throws(() => normalizeCateringOrderSnapshot(value, f.expected));
  assert.equal(reads, 0);
  for (const changed of [Object.defineProperty(structuredClone(f.snapshot), 'hidden', { value: true }),
    { ...f.snapshot, [Symbol('authority')]: true }]) assert.throws(() => normalizeCateringOrderSnapshot(changed, f.expected));
});
