import { integrationDeliveryDecision } from '../integrations/delivery-policy.js';

export function cateringJobFailureDecision({ attempt, outcome, retryable, retryAfterMs = null, jitter } = {}) {
  const decision = integrationDeliveryDecision({ operation: 'write', attempt, outcome, retryable, retryAfterMs, jitter });
  return Object.freeze({ status: decision.action === 'reconcile' ? 'reconciliation_required'
    : decision.action === 'retry' ? 'retry_wait' : 'failed', delayMs: decision.delayMs });
}
