import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCateringProvider, normalizeCateringReceipt } from '../src/integrations/catering-contract.js';

const ORDER_ID = '10000000-0000-4000-8000-000000000001';
const FIRST = '20000000-0000-4000-8000-000000000001';
const SECOND = '20000000-0000-4000-8000-000000000002';
const OTHER = '20000000-0000-4000-8000-000000000003';
const expected = () => ({ orderId: ORDER_ID, orderVersion: 2, positionIds: [FIRST, SECOND] });
const receipt = () => ({ orderId: ORDER_ID, orderVersion: 2, positions: [
  { positionId: FIRST, outcome: 'confirmed' }, { positionId: SECOND, outcome: 'rejected' },
] });
const descriptor = (capabilities) => ({ id: 'reference_caterer', runtime: 'demo', capabilities });

test('a non-Microsoft reference adapter implements only declared API capabilities', async () => {
  const provider = {
    async readCatalogue() { return []; },
    async placeOrder() { return receipt(); },
  };
  assert.equal(assertCateringProvider(descriptor({ 'catering.catalogue': 'api', 'catering.order': 'api' }), provider), provider);
  const result = normalizeCateringReceipt(await provider.placeOrder(), expected());
  assert.equal(result.counts.confirmed, 1);
  assert.equal(result.counts.rejected, 1);
  assert.equal(result.positions[0].outcome, 'confirmed');
});

test('manual capabilities never require a fabricated API method and unsupported providers fail', () => {
  assert.doesNotThrow(() => assertCateringProvider(descriptor({ 'catering.catalogue': 'api', 'catering.order': 'manual' }), {
    readCatalogue() {},
  }));
  assert.doesNotThrow(() => assertCateringProvider(descriptor({ 'catering.order': 'manual' }), {}));
  for (const capabilities of [{ 'calendar.create': 'api' }, { 'catering.order': 'unsupported' }]) {
    assert.throws(() => assertCateringProvider(descriptor(capabilities), {}), /CAPABILITY_REQUIRED/);
  }
  for (const capability of ['catalogue', 'availability', 'order', 'update', 'cancel', 'status']) {
    assert.throws(() => assertCateringProvider(descriptor({ [`catering.${capability}`]: 'api' }), {}), /METHOD_REQUIRED/);
  }
  for (const provider of [null, [], () => {}]) {
    assert.throws(() => assertCateringProvider(descriptor({ 'catering.order': 'manual' }), provider), /PROVIDER_REQUIRED/);
  }
});

test('partial rejection and substitution do not overwrite another position confirmation', () => {
  const value = receipt();
  value.positions[1].outcome = 'substitution_proposed';
  const result = normalizeCateringReceipt(value, expected());
  assert.deepEqual(result.counts, { confirmed: 1, rejected: 0, pending: 0, substitution_proposed: 1 });
  assert.equal(result.positions[0].outcome, 'confirmed');
  assert.equal(result.positions[1].outcome, 'substitution_proposed');
  value.positions[0].outcome = 'rejected';
  assert.equal(result.positions[0].outcome, 'confirmed');
  assert.throws(() => { result.positions[1].outcome = 'confirmed'; }, TypeError);
  assert.throws(() => { result.counts.confirmed = 2; }, TypeError);
});

test('wrong order/version, missing/duplicate/foreign positions and invented success fail closed', () => {
  for (const mutate of [
    (v) => { v.orderId = OTHER; }, (v) => { v.orderVersion = 1; },
    (v) => { v.positions.pop(); }, (v) => { v.positions.push({ positionId: OTHER, outcome: 'confirmed' }); },
    (v) => { v.positions[1].positionId = FIRST; }, (v) => { v.positions[1].positionId = OTHER; },
    (v) => { v.positions[1].outcome = 'delivered'; }, (v) => { v.positions[1].outcome = 'exported'; },
    (v) => { v.status = 'confirmed'; }, (v) => { v.tenantId = ORDER_ID; },
    (v) => { v.positions[1].approvedCostMinor = 100; },
    (v) => { delete v.positions[1]; },
  ]) {
    const value = receipt(); mutate(value);
    assert.throws(() => normalizeCateringReceipt(value, expected()), { message: 'CATERING_RECEIPT_INVALID' });
  }
});

test('receipt completeness accepts all pending outcomes and does not turn transmission into confirmation', () => {
  const value = receipt();
  value.positions.forEach((p) => { p.outcome = 'pending'; });
  assert.deepEqual(normalizeCateringReceipt(value, expected()).counts,
    { confirmed: 0, rejected: 0, pending: 2, substitution_proposed: 0 });
});

test('persisted expected scope must be bounded, exact and valid before provider data is trusted', () => {
  for (const overrides of [
    { orderId: 'external_order' }, { orderVersion: 0 }, { orderVersion: 1.5 },
    { positionIds: [] }, { positionIds: [FIRST, FIRST] }, { positionIds: [FIRST, 'external_item'] },
    { positionIds: Array(101).fill(FIRST) }, { tenantId: ORDER_ID },
    { positionIds: Object.assign(new Array(2), { 0: FIRST }) },
  ]) assert.throws(() => normalizeCateringReceipt(receipt(), { ...expected(), ...overrides }), /RECEIPT_INVALID/);
  assert.throws(() => normalizeCateringReceipt(receipt(), null), /RECEIPT_INVALID/);
  for (const value of [null, [], Object.create(receipt())]) {
    assert.throws(() => normalizeCateringReceipt(value, expected()), /RECEIPT_INVALID/);
  }
  const input = receipt(); let invoked = false;
  Object.defineProperty(input.positions[0], 'outcome', { enumerable: true, get() { invoked = true; return 'confirmed'; } });
  assert.throws(() => normalizeCateringReceipt(input, expected()), /RECEIPT_INVALID/);
  assert.equal(invoked, false);
  const indexed = receipt();
  Object.defineProperty(indexed.positions, '0', { enumerable: true, get() { invoked = true; return input.positions[0]; } });
  assert.throws(() => normalizeCateringReceipt(indexed, expected()), /RECEIPT_INVALID/);
  assert.equal(invoked, false);
  for (const mutate of [
    (v) => { v[Symbol('hidden')] = true; },
    (v) => { Object.defineProperty(v, 'privateField', { value: true }); },
    (v) => { v.positions.extra = true; },
  ]) {
    const value = receipt(); mutate(value);
    assert.throws(() => normalizeCateringReceipt(value, expected()), /RECEIPT_INVALID/);
  }
});

test('receipt position bound is inclusive at one hundred distinct internal positions', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`);
  const value = { orderId: ORDER_ID, orderVersion: 2, positions: ids.map((positionId) => ({ positionId, outcome: 'confirmed' })) };
  assert.equal(normalizeCateringReceipt(value, { ...expected(), positionIds: ids }).counts.confirmed, 100);
});
