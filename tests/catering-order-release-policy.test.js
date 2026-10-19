import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCateringOrderRelease } from '../src/domain/catering-order-release-policy.js';

const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cost = (amountMinor = 1000, currency = 'EUR') => ({ amountMinor, currency });
function evidence(extra = {}) {
  return { initialOrderMode: 'after_conference_approval', operation: 'initial', conferenceApproved: true,
    originalProviderCost: cost(), quote: { revision: 2, cost: cost(), expiresAt: '2026-10-20T10:00:00.000Z' },
    managerApproval: null, expected: { tenantId: id(1), integrationId: id(2), orderId: id(3), orderVersion: 4 },
    startsAt: '2026-10-20T09:00:00.000Z', now: '2026-10-19T10:00:00.000Z', ...extra };
}
function approve(value) {
  return { ...value.expected, quoteRevision: value.quote.revision, cost: value.quote.cost,
    decision: 'approved', deciderUserId: id(4) };
}

test('only explicit automatic initial mode can release an unchanged known supplier quote after conference approval', () => {
  assert.deepEqual(evaluateCateringOrderRelease(evidence()), {
    eligible: true, businessReview: 'conference_approval', costReview: 'no_extra_cost', reasons: [],
  });
  assert.deepEqual(evaluateCateringOrderRelease(evidence({ conferenceApproved: false })).reasons, ['conference_not_approved']);
  for (const operation of ['initial', 'change', 'cancel', 'exception']) {
    const value = evidence({ initialOrderMode: 'manager_review', operation });
    assert.equal(evaluateCateringOrderRelease(value).eligible, false);
    assert.equal(evaluateCateringOrderRelease({ ...value, managerApproval: approve(value) }).eligible, true);
  }
  for (const operation of ['change', 'cancel', 'exception']) {
    assert.equal(evaluateCateringOrderRelease(evidence({ operation })).eligible, false);
  }
  const cancellation = evidence({ operation: 'cancel', conferenceApproved: false });
  assert.equal(evaluateCateringOrderRelease(cancellation).eligible, false);
  assert.equal(evaluateCateringOrderRelease({ ...cancellation, managerApproval: approve(cancellation) }).eligible, true);
});

test('unknown supplier cost, additional cost and currency changes always need exact current Manager acceptance', () => {
  for (const extra of [{ originalProviderCost: null }, { quote: { ...evidence().quote, cost: cost(1001) } },
    { quote: { ...evidence().quote, cost: cost(0, 'USD') } }]) {
    const value = evidence(extra);
    const outcome = evaluateCateringOrderRelease(value);
    assert.equal(outcome.costReview, 'manager_review');
    assert.deepEqual(outcome.reasons, ['manager_approval_required']);
    assert.equal(evaluateCateringOrderRelease({ ...value, managerApproval: approve(value) }).eligible, true);
  }
});

test('expiry boundary, unapproved conference, changed quote and cross-scope approval cannot release', () => {
  const value = evidence({ originalProviderCost: null });
  const managerApproval = approve(value);
  assert.equal(evaluateCateringOrderRelease({ ...value, managerApproval }).eligible, true);
  for (const extra of [{ now: value.quote.expiresAt }, { now: value.startsAt }, { now: '2026-10-21T10:00:00.000Z' },
    { conferenceApproved: false }, { quote: { ...value.quote, revision: 3 } },
    { quote: { ...value.quote, cost: cost(1001) } }, { expected: { ...value.expected, orderVersion: 5 } },
    { managerApproval: { ...managerApproval, tenantId: id(8) } },
    { managerApproval: { ...managerApproval, integrationId: id(8) } },
    { managerApproval: { ...managerApproval, decision: 'rejected' } }]) {
    assert.equal(evaluateCateringOrderRelease({ ...value, managerApproval, ...extra }).eligible, false);
  }
});

test('closed evidence, strict instants and unknown policy states fail without authority fallback', () => {
  for (const extra of [{ initialOrderMode: 'automatic' }, { operation: 'send' }, { conferenceApproved: 'true' },
    { originalProviderCost: undefined }, { managerApproval: undefined }, { now: '2026-10-19' },
    { now: '2026-02-30T10:00:00.000Z' }, { startsAt: undefined }, { quote: { ...evidence().quote, approved: true } },
    { quote: { ...evidence().quote, expiresAt: 'tomorrow' } }]) {
    assert.throws(() => evaluateCateringOrderRelease(evidence(extra)));
  }
  let reads = 0;
  const quote = evidence().quote;
  Object.defineProperty(quote, 'expiresAt', { enumerable: true, get() { reads++; return evidence().quote.expiresAt; } });
  assert.throws(() => evaluateCateringOrderRelease(evidence({ quote })));
  assert.equal(reads, 0);
});
