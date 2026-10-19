import assert from 'node:assert/strict';
import test from 'node:test';
import { cateringOrderStateFromReceipt, effectiveCateringVersionAfterReceipt } from '../src/domain/catering-receipt-state.js';

const counts = (confirmed = 0, rejected = 0, pending = 0, substitution_proposed = 0) => ({
  confirmed, rejected, pending, substitution_proposed,
});
const candidate = (operation, result, orderVersion = 2) => ({ operation, positionCount: 2, counts: result, orderVersion });

test('complete receipts preserve confirmed, cancelled, partial, rejected and unaccepted substitution states', () => {
  for (const operation of ['initial','change','cancel','exception']) {
    assert.equal(cateringOrderStateFromReceipt(candidate(operation, counts(2))), operation === 'cancel' ? 'cancelled' : 'confirmed');
    for (const other of [counts(1,1),counts(1,0,1),counts(1,0,0,1)]) {
      assert.equal(cateringOrderStateFromReceipt(candidate(operation, other)), 'partially_confirmed');
    }
    assert.equal(cateringOrderStateFromReceipt(candidate(operation, counts(0,2))), 'rejected');
    for (const other of [counts(0,0,2),counts(0,0,0,2),counts(0,1,0,1)]) {
      assert.equal(cateringOrderStateFromReceipt(candidate(operation, other)), 'transmitted');
    }
  }
});

test('original effective order remains until complete replacement/cancellation confirmation and cannot be rolled back', () => {
  const original = { orderVersion: 1, status: 'confirmed' };
  for (const operation of ['change','cancel','exception']) {
    for (const result of [counts(1,1),counts(0,2),counts(0,0,2),counts(0,0,0,2)]) {
      assert.deepEqual(effectiveCateringVersionAfterReceipt(original, candidate(operation, result)), original);
      assert.equal(effectiveCateringVersionAfterReceipt(null, candidate(operation, result)), null);
    }
    assert.deepEqual(effectiveCateringVersionAfterReceipt(original, candidate(operation, counts(2))), {
      orderVersion: 2, status: operation === 'cancel' ? 'cancelled' : 'confirmed',
    });
  }
  const current = { orderVersion: 3, status: 'cancelled' };
  assert.deepEqual(effectiveCateringVersionAfterReceipt(current, candidate('change', counts(2), 2)), current);
  assert.deepEqual(effectiveCateringVersionAfterReceipt(current, candidate('cancel', counts(2), 3)), current);
  assert.deepEqual(original, { orderVersion: 1, status: 'confirmed' });
});

test('receipt state rejects incomplete counts, malformed authority-like fields and accessors', () => {
  for (const result of [counts(3),counts(0,0,1),counts(-1,0,3),counts(0.5,0,1.5),
    { ...counts(2), cost: 100 }, { confirmed: 2 }, null, [], { ...counts(2), pending: NaN }]) {
    assert.throws(() => cateringOrderStateFromReceipt(candidate('initial', result)), /INVALID/);
  }
  for (const count of [0,102,Number.MAX_SAFE_INTEGER,NaN,'2']) {
    assert.throws(() => cateringOrderStateFromReceipt({ ...candidate('initial', counts(2)), positionCount: count }), /INVALID/);
  }
  for (const operation of ['confirm','toString',undefined]) {
    assert.throws(() => cateringOrderStateFromReceipt(candidate(operation, counts(2))), /INVALID/);
  }
  let reads = 0; const getter = counts(2);
  Object.defineProperty(getter, 'confirmed', { enumerable: true, get() { reads++; return 2; } });
  assert.throws(() => cateringOrderStateFromReceipt(candidate('initial', getter)), /INVALID/); assert.equal(reads, 0);
  for (const current of [{ orderVersion: 1, status: 'transmitted' }, { orderVersion: 0, status: 'confirmed' },
    { orderVersion: 1, status: 'confirmed', tenantId: 'foreign' }]) {
    assert.throws(() => effectiveCateringVersionAfterReceipt(current, candidate('change', counts(2))), /INVALID/);
  }
});
