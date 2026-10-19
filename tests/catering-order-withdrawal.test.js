import assert from 'node:assert/strict';
import test from 'node:test';
import { cateringOrderWithdrawalEligibility as eligibility,
  normalizeCateringWithdrawalCommand } from '../src/domain/catering-order-withdrawal.js';

const id = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const pending = (extra = {}) => ({ orderVersion: 1, status: 'pending_quote', decision: null,
  effective: null, manualSequence: 0, job: null, ...extra });
const waiting = (job = {}) => pending({ status: 'queued', decision: 'approved', job: {
  status: 'queued', dispatchAttempts: 0, hasAttempt: false, hasObservation: false, leaseActive: false, ...job,
} });

test('a local withdrawal stops only demonstrably unsent work and preserves a prior confirmed commitment', () => {
  for (const value of [pending(), pending({ status: 'pending_manager_review' }), pending({ status: 'released', decision: 'approved' }),
    pending({ status: 'rejected', decision: 'rejected' }), waiting(), waiting({ status: 'deferred' })]) {
    assert.deepEqual(eligibility(value), { eligible: true, retainedEffectiveVersion: null });
  }
  assert.deepEqual(eligibility(pending({ orderVersion: 2, effective: { orderVersion: 1, status: 'confirmed' } })),
    { eligible: true, retainedEffectiveVersion: 1 });
  for (const extra of [{ manualSequence: 1 }, { status: 'transmitted' }, { status: 'partially_confirmed' },
    { status: 'reconciliation_required' }, { status: 'confirmed' }, { status: 'cancelled' },
    { effective: { orderVersion: 1, status: 'confirmed' } },
    { orderVersion: 2, effective: { orderVersion: 1, status: 'cancelled' } },
    { status: 'rejected', decision: 'approved' }, { status: 'queued', decision: 'approved' }]) {
    assert.equal(eligibility(pending(extra)).eligible, false);
  }
});

test('leases, durable intent, observations and every uncertain or transmitted job outcome prohibit local withdrawal', () => {
  for (const extra of [{ dispatchAttempts: 1 }, { hasAttempt: true }, { hasObservation: true }, { leaseActive: true },
    ...['leased','dispatching','reconciling','retry_wait','reconciliation_required','succeeded','failed','superseded']
      .map((status) => ({ status }))]) {
    assert.equal(eligibility(waiting(extra)).eligible, false);
  }
  for (const value of [waiting({ dispatchAttempts: -1 }), waiting({ hasAttempt: 0 }), waiting({ hasObservation: 'false' }),
    waiting({ leaseActive: 'false' }), pending({ orderVersion: 0 }), pending({ manualSequence: -1 }),
    pending({ effective: { orderVersion: 2, status: 'confirmed' } }), pending({ providerAuthorized: true })]) {
    assert.throws(() => eligibility(value), /INVALID/);
  }
});

test('withdrawal commands are closed, scoped, version-bound and explicitly justified without accepting delivery authority', () => {
  const command = { schemaVersion: 1, commandId: id(2), expectedOrderVersion: 1, expectedStateRevision: 3,
    justification: 'Synthetic local withdrawal', attestNotTransmitted: true };
  assert.equal(Object.isFrozen(normalizeCateringWithdrawalCommand(command, { orderId: id(1) })), true);
  for (const extra of [{ tenantId: id(3) }, { status: 'cancelled' }, { expectedOrderVersion: 0 }, { expectedStateRevision: 1.5 },
    { commandId: '../foreign' }, { attestNotTransmitted: false }, { justification: '' }, { justification: 'x'.repeat(1001) },
    { justification: 'a\nb' }]) {
    assert.throws(() => normalizeCateringWithdrawalCommand({ ...command, ...extra }, { orderId: id(1) }), /INVALID/);
  }
  let reads = 0;
  const malicious = { ...command };
  Object.defineProperty(malicious, 'justification', { enumerable: true, get() { reads++; return 'unsafe'; } });
  assert.throws(() => normalizeCateringWithdrawalCommand(malicious, { orderId: id(1) }), /INVALID/); assert.equal(reads, 0);
});
