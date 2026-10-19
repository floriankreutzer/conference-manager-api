import assert from 'node:assert/strict';
import test from 'node:test';
import { integrationDeliveryDecision } from '../src/integrations/delivery-policy.js';

function decision(overrides = {}) {
  return integrationDeliveryDecision({
    operation: 'read', outcome: 'unknown', retryable: true, attempt: 1, jitter: 0,
    ...overrides,
  });
}

test('transient reads have bounded exponential backoff with injected jitter and Retry-After floor', () => {
  assert.deepEqual(decision(), { action: 'retry', delayMs: 1_000 });
  assert.deepEqual(decision({ attempt: 2, jitter: 1 }), { action: 'retry', delayMs: 4_000 });
  assert.deepEqual(decision({ retryAfterMs: 300_000, jitter: 1 }), { action: 'retry', delayMs: 300_000 });
  assert.deepEqual(decision({ retryAfterMs: 1, jitter: 0.5 }), { action: 'retry', delayMs: 1_500 });
  assert.deepEqual(decision({ attempt: 3 }), { action: 'stop', delayMs: null });
  assert.deepEqual(decision({ retryable: false }), { action: 'stop', delayMs: null });
});

test('ambiguous writes always reconcile, even when classified permanent or retry budget is exhausted', () => {
  for (const retryable of [true, false]) {
    for (const attempt of [1, 2, 3]) {
      assert.deepEqual(decision({ operation: 'write', retryable, attempt }), { action: 'reconcile', delayMs: null });
    }
  }
});

test('writes retry only when adapter proves no request was sent; rejection cannot become blind replay', () => {
  assert.deepEqual(decision({ operation: 'write', outcome: 'not_sent' }), { action: 'retry', delayMs: 1_000 });
  assert.deepEqual(decision({ operation: 'write', outcome: 'not_sent', retryable: false }), { action: 'stop', delayMs: null });
  assert.deepEqual(decision({ operation: 'write', outcome: 'rejected' }), { action: 'stop', delayMs: null });
});

test('invalid classifications, attempts, jitter and retry bounds fail closed', () => {
  for (const overrides of [
    { operation: 'place_order' }, { operation: null }, { outcome: 'success' }, { outcome: 'sent' },
    { retryable: 'true' }, { retryable: null }, { attempt: 0 }, { attempt: 4 }, { attempt: 1.5 },
    { retryAfterMs: -1 }, { retryAfterMs: 300_001 }, { retryAfterMs: 0.5 }, { retryAfterMs: '1000' },
    { jitter: NaN }, { jitter: Infinity }, { jitter: -0.1 }, { jitter: 1.1 }, { jitter: undefined },
  ]) assert.throws(() => decision(overrides), TypeError);
  assert.throws(() => integrationDeliveryDecision(), /CLASSIFICATION_INVALID/);
});

test('policy produces immutable, minimized decisions without provider payloads or false success', () => {
  const result = decision();
  assert.deepEqual(Object.keys(result), ['action', 'delayMs']);
  assert.throws(() => { result.action = 'success'; }, TypeError);
  for (const operation of ['read', 'write']) {
    for (const outcome of ['not_sent', 'rejected', 'unknown']) {
      assert.notEqual(decision({ operation, outcome }).action, 'success');
    }
  }
});
