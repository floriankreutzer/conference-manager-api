import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringOrderTotal } from '../src/domain/catering-order-money.js';
import { MAX_PRICE_MINOR, normalizeMoney } from '../src/domain/money.js';
import { cateringExtraCostReviewRequirement, cateringQuoteHasCurrentApproval } from '../src/domain/catering-approval-policy.js';

const money = (amountMinor, currency = 'EUR') => ({ amountMinor, currency });
const id = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('aggregate validation supports full legitimate Catering quantities without raising unit-price bounds', () => {
  const total = (100 * 1000 + 500) * MAX_PRICE_MINOR;
  assert.deepEqual(normalizeCateringOrderTotal(money(total)), money(total));
  assert.throws(() => normalizeMoney(money(MAX_PRICE_MINOR + 1)), /MONEY_AMOUNT_INVALID/);
  assert.equal(normalizeMoney(money(MAX_PRICE_MINOR)).amountMinor, MAX_PRICE_MINOR);
  assert.equal(cateringExtraCostReviewRequirement(money(total), money(total + 1)), 'manager_review');
  assert.equal(cateringExtraCostReviewRequirement(money(total), money(total - 1)), 'no_extra_cost');
  assert.equal(cateringExtraCostReviewRequirement(money(total), money(total, 'USD')), 'manager_review');
  const scope = { tenantId: id(1), integrationId: id(2), orderId: id(3), orderVersion: 1 };
  const quote = { revision: 1, cost: money(total) };
  const approval = { ...scope, quoteRevision: 1, cost: money(total), decision: 'approved', deciderUserId: id(4) };
  assert.equal(cateringQuoteHasCurrentApproval(quote, approval, scope), true);
  assert.equal(cateringQuoteHasCurrentApproval({ ...quote, cost: money(total + 1) }, approval, scope), false);
});
test('aggregate bounds, supported currencies and closed plain records fail without accessor execution', () => {
  for (const value of [money(-1), money(1.1), money(Number.MAX_SAFE_INTEGER), money(Infinity), money(1, 'XYZ'),
    { ...money(1), role: 'manager' }, Object.create(money(1)), null, [],
    Object.defineProperty(money(1), 'hidden', { value: true }), { ...money(1), [Symbol('extra')]: true }]) {
    assert.throws(() => normalizeCateringOrderTotal(value), /TOTAL_INVALID/);
  }
  let reads = 0;
  const value = money(1);
  Object.defineProperty(value, 'currency', { enumerable: true, get() { reads++; return 'EUR'; } });
  assert.throws(() => normalizeCateringOrderTotal(value), /TOTAL_INVALID/);
  assert.equal(reads, 0);
  assert.equal(normalizeCateringOrderTotal(money(Number.MAX_SAFE_INTEGER - 1)).amountMinor, Number.MAX_SAFE_INTEGER - 1);
});
