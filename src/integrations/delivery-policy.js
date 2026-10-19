const OPERATIONS = new Set(['read', 'write']);
const OUTCOMES = new Set(['not_sent', 'rejected', 'unknown']);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 300_000;
const BASE_DELAY_MS = 1_000;

// Scheduling policy only. The worker must persist attempts and reconcile ambiguous writes.
export function integrationDeliveryDecision({ operation, outcome, retryable, attempt, retryAfterMs = null, jitter } = {}) {
  if (!OPERATIONS.has(operation) || !OUTCOMES.has(outcome) || typeof retryable !== 'boolean') {
    throw new TypeError('INTEGRATION_DELIVERY_CLASSIFICATION_INVALID');
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new TypeError('INTEGRATION_DELIVERY_ATTEMPT_INVALID');
  }
  if (retryAfterMs !== null
    && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > MAX_RETRY_AFTER_MS)) {
    throw new TypeError('INTEGRATION_DELIVERY_RETRY_AFTER_INVALID');
  }
  if (typeof jitter !== 'number' || !Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError('INTEGRATION_DELIVERY_JITTER_INVALID');
  }
  if (operation === 'write' && outcome === 'unknown') {
    return Object.freeze({ action: 'reconcile', delayMs: null });
  }
  // Even idempotent writes need durable scope/reconciliation; this policy never assumes that proof.
  if (!retryable || attempt === MAX_ATTEMPTS || (operation === 'write' && outcome !== 'not_sent')) {
    return Object.freeze({ action: 'stop', delayMs: null });
  }
  const backoffMs = BASE_DELAY_MS * (2 ** (attempt - 1));
  const delayMs = Math.max(retryAfterMs ?? 0, backoffMs + Math.floor(backoffMs * jitter));
  return Object.freeze({ action: 'retry', delayMs });
}
