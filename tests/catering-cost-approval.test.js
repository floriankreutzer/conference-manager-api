import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cateringExtraCostReviewRequirement,
  cateringQuoteHasCurrentApproval,
} from '../src/domain/catering-approval-policy.js';

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const expected = { tenantId: id(1), integrationId: id(2), orderId: id(3), orderVersion: 4 };
const money = (amountMinor = 1200, currency = 'EUR') => ({ amountMinor, currency });
const quote = () => ({ revision: 2, cost: money() });
const approved = () => ({
  ...expected, quoteRevision: 2, cost: money(), decision: 'approved', deciderUserId: id(5),
});

test('extra cost and currency changes require Manager review without comparing different currencies', () => {
  assert.equal(cateringExtraCostReviewRequirement(money(1000), money(1001)), 'manager_review');
  assert.equal(cateringExtraCostReviewRequirement(money(1000), money(0, 'USD')), 'manager_review');
  assert.equal(cateringExtraCostReviewRequirement(money(1000), money(1000)), 'no_extra_cost');
  assert.equal(cateringExtraCostReviewRequirement(money(1000), money(0)), 'no_extra_cost');
});

test('only exact approved evidence matches the current scoped order, quote revision and cost', () => {
  assert.equal(cateringQuoteHasCurrentApproval(quote(), approved(), expected), true);
  assert.equal(cateringQuoteHasCurrentApproval(quote(), null, expected), false);
  assert.equal(cateringQuoteHasCurrentApproval(quote(), { ...approved(), decision: 'rejected' }, expected), false);
  for (const changed of [
    { tenantId: id(6) }, { integrationId: id(6) }, { orderId: id(6) }, { orderVersion: 5 },
    { quoteRevision: 3 }, { cost: money(1201) }, { cost: money(1199) }, { cost: money(1200, 'USD') },
  ]) assert.equal(cateringQuoteHasCurrentApproval(quote(), { ...approved(), ...changed }, expected), false);
});

test('new versions and same-price quote revisions still invalidate earlier acceptance', () => {
  assert.equal(cateringQuoteHasCurrentApproval({ revision: 3, cost: money() }, approved(), expected), false);
  assert.equal(cateringQuoteHasCurrentApproval(quote(), approved(), { ...expected, orderVersion: 5 }), false);
  const otherProvider = { ...expected, integrationId: id(7) };
  const otherApproval = { ...approved(), integrationId: id(7) };
  assert.equal(cateringQuoteHasCurrentApproval(quote(), otherApproval, otherProvider), true);
  assert.equal(cateringQuoteHasCurrentApproval(quote(), otherApproval, expected), false);
  assert.equal(cateringQuoteHasCurrentApproval(quote(), approved(), expected), true);
});

test('malformed or authority-bearing quote, scope and approval records fail closed', () => {
  for (const revision of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
    assert.throws(() => cateringQuoteHasCurrentApproval({ revision, cost: money() }, approved(), expected));
    assert.throws(() => cateringQuoteHasCurrentApproval(quote(), { ...approved(), quoteRevision: revision }, expected));
    assert.throws(() => cateringQuoteHasCurrentApproval(quote(), approved(), { ...expected, orderVersion: revision }));
  }
  for (const invalid of [undefined, {}, [], { ...approved(), decision: 'accepted' },
    { ...approved(), deciderUserId: 'manager' }, { ...approved(), authorized: true },
    { ...approved(), tenantId: null }, Object.create(approved())]) {
    assert.throws(() => cateringQuoteHasCurrentApproval(quote(), invalid, expected));
  }
  assert.throws(() => cateringQuoteHasCurrentApproval({ ...quote(), approved: true }, approved(), expected));
  assert.throws(() => cateringQuoteHasCurrentApproval(quote(), approved(), { ...expected, role: 'manager' }));
});

test('money validation preserves bounds and rejects hidden, accessor and symbol authority without invoking getters', () => {
  for (const invalid of [money(-1), money(1.1), money(Number.MAX_SAFE_INTEGER), money(1, 'XYZ'),
    { ...money(), price: 0 }, Object.create(money())]) {
    assert.throws(() => cateringExtraCostReviewRequirement(money(), invalid));
    assert.throws(() => cateringQuoteHasCurrentApproval({ revision: 2, cost: invalid }, approved(), expected));
  }
  let reads = 0;
  const accessor = { ...approved() };
  Object.defineProperty(accessor, 'decision', { enumerable: true, get() { reads += 1; return 'approved'; } });
  assert.throws(() => cateringQuoteHasCurrentApproval(quote(), accessor, expected));
  assert.equal(reads, 0);
  const hidden = Object.defineProperty(money(), 'authorization', { value: true });
  assert.throws(() => cateringExtraCostReviewRequirement(money(), hidden));
  const symbolic = { ...approved(), [Symbol('approval')]: true };
  assert.throws(() => cateringQuoteHasCurrentApproval(quote(), symbolic, expected));
});

test('approval checks cannot mutate or relabel persisted evidence', () => {
  const source = Object.freeze({ ...approved(), cost: Object.freeze(money()) });
  const proposed = Object.freeze({ revision: 2, cost: Object.freeze(money()) });
  const scope = Object.freeze({ ...expected });
  assert.equal(cateringQuoteHasCurrentApproval(proposed, source, scope), true);
  assert.deepEqual(source, approved());
  assert.deepEqual(proposed, quote());
  assert.deepEqual(scope, expected);
});
