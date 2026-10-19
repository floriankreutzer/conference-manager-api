import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cateringJobIdempotencyScope, cateringJobLeaseRecovery,
} from '../src/domain/catering-job-policy.js';
import { cateringJobFailureDecision } from '../src/application/catering-job-failure-policy.js';

const id = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = () => ({ tenantId: id(1), integrationId: id(2), orderId: id(3), orderVersion: 1, operation: 'initial' });

test('durable idempotency scope separates every Tenant, connection, order, version and operation', () => {
  const original = cateringJobIdempotencyScope(scope());
  assert.equal(cateringJobIdempotencyScope({ ...scope(), tenantId: id(1).toUpperCase() }), original);
  for (const change of [{ tenantId: id(4) }, { integrationId: id(4) }, { orderId: id(4) }, { orderVersion: 2, operation: 'change' },
    { orderVersion: 3, operation: 'change' }, { orderVersion: 2, operation: 'cancel' }, { orderVersion: 2, operation: 'exception' }]) {
    assert.notEqual(cateringJobIdempotencyScope({ ...scope(), ...change }), original);
  }
  for (const change of [{ orderVersion: 0 }, { orderVersion: Number.MAX_SAFE_INTEGER }, { orderVersion: '1' },
    { operation: '__proto__' }, { orderVersion: 2, operation: 'initial' }, { operation: 'change' },
    { tenantId: 'untrusted' }, { endpoint: 'https://untrusted.invalid' }]) {
    assert.throws(() => cateringJobIdempotencyScope({ ...scope(), ...change }));
  }
  let reads = 0;
  const getter = Object.defineProperty(scope(), 'tenantId', { enumerable: true, get() { reads++; return id(1); } });
  assert.throws(() => cateringJobIdempotencyScope(getter)); assert.equal(reads, 0);
});

test('lease expiry distinguishes pre-dispatch admission from unknown writes and reconciliation', () => {
  assert.equal(cateringJobLeaseRecovery({ status: 'leased', leaseExpired: true }), 'queued');
  for (const status of ['dispatching','reconciling']) {
    assert.equal(cateringJobLeaseRecovery({ status, leaseExpired: true }), 'reconciliation_required');
    assert.equal(cateringJobLeaseRecovery({ status, leaseExpired: false }), null);
  }
  for (const status of ['queued','retry_wait','deferred','reconciliation_required','succeeded','failed','superseded']) {
    assert.equal(cateringJobLeaseRecovery({ status, leaseExpired: true }), null);
  }
  for (const value of [{ status: 'unknown', leaseExpired: true }, { status: 'dispatching', leaseExpired: 'true' }]) {
    assert.throws(() => cateringJobLeaseRecovery(value));
  }
});

test('unknown writes always reconcile, rejected writes stop, and only proven not-sent writes can retry', () => {
  for (const attempt of [1,2,3]) for (const retryable of [false,true]) {
    assert.deepEqual(cateringJobFailureDecision({ attempt, retryable, outcome: 'unknown', jitter: 0 }),
      { status: 'reconciliation_required', delayMs: null });
    assert.deepEqual(cateringJobFailureDecision({ attempt, retryable, outcome: 'rejected', jitter: 0 }),
      { status: 'failed', delayMs: null });
  }
  assert.deepEqual(cateringJobFailureDecision({ attempt: 1, retryable: true, outcome: 'not_sent', retryAfterMs: 90000, jitter: 1 }),
    { status: 'retry_wait', delayMs: 90000 });
  assert.deepEqual(cateringJobFailureDecision({ attempt: 3, retryable: true, outcome: 'not_sent', jitter: 0 }),
    { status: 'failed', delayMs: null });
  for (const change of [{ attempt: 4 }, { jitter: 1.1 }, { retryAfterMs: 300001 }, { outcome: 'maybe_sent' }, { retryable: 'true' }]) {
    assert.throws(() => cateringJobFailureDecision({ attempt: 1, outcome: 'not_sent', retryable: true, jitter: 0, ...change }));
  }
});
