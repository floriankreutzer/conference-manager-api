import { normalizeCateringDeliveryJob } from '../domain/catering-delivery-job.js';
import { normalizeCateringOrderSnapshot } from '../domain/catering-order-snapshot-value.js';
import { normalizeCateringOrderTotal } from '../domain/catering-order-money.js';
import { cateringJobIdempotencyScope } from '../domain/catering-job-policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { assertCateringProvider, normalizeCateringReceipt, CateringDeliveryError } from '../integrations/catering-contract.js';
import { cateringJobFailureDecision } from './catering-job-failure-policy.js';

const METHODS = { initial: 'placeOrder', change: 'changeOrder', cancel: 'cancelOrder', exception: 'changeOrder' };
function invalid() { throw new TypeError('CATERING_JOB_PROCESSOR_PORT_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function lease(value, registry) {
  record(value, ['kind','job','leaseId','providerId','mode','snapshot','quote']);
  if (!['dispatch','reconcile'].includes(value.kind) || !isInternalUuid(value.leaseId)
    || !['api','manual','unsupported'].includes(value.mode) || registry.get(value.providerId).id !== value.providerId) invalid();
  const job = normalizeCateringDeliveryJob(value.job, { tenantId: value.job?.tenantId });
  if (job.status !== (value.kind === 'dispatch' ? 'leased' : 'reconciling')
    || (value.kind === 'dispatch' && job.dispatchAttempts >= 3)) invalid();
  const snapshot = normalizeCateringOrderSnapshot(value.snapshot, { tenantId: job.tenantId, orderId: job.orderId });
  if (snapshot.orderVersion !== job.orderVersion || snapshot.integrationId !== job.integrationId) invalid();
  record(value.quote, ['revision','cost']);
  if (value.quote.revision !== job.quoteRevision) invalid();
  return Object.freeze({ ...value, job, snapshot,
    quote: Object.freeze({ revision: job.quoteRevision, cost: normalizeCateringOrderTotal(value.quote.cost) }) });
}
function failure(error) {
  return error instanceof CateringDeliveryError ? { outcome: error.outcome, retryable: error.retryable,
    failureCode: error.code, retryAfterMs: error.retryAfterMs }
    : { outcome: 'unknown', retryable: false, failureCode: 'unknown', retryAfterMs: null };
}

async function providerResult(work, signal, timeoutMs) {
  const timeoutController = new AbortController();
  const combined = AbortSignal.any([signal, timeoutController.signal]);
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (combined.aborted) throw new CateringDeliveryError('unavailable', { outcome: 'not_sent', retryable: true });
      return work(combined);
    }), new Promise((_, reject) => {
      timer = setTimeout(() => {
        timeoutController.abort(); reject(new CateringDeliveryError('timeout'));
      }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Execution orchestration only. The repository owns durable claims, intent-before-
// I/O, database-clock authority and lease-fenced observation/order/audit commits.
export function createCateringJobProcessor({ repository, registry, providers, jitter = Math.random, providerTimeoutMs = 10000 } = {}) {
  if (!repository || !['claimNext','beginDispatch','defer','finish'].every((key) => typeof repository[key] === 'function')) invalid();
  if (!registry || typeof registry.get !== 'function' || !providers || typeof providers.resolve !== 'function'
    || typeof jitter !== 'function' || !Number.isSafeInteger(providerTimeoutMs)
    || providerTimeoutMs < 10 || providerTimeoutMs > 30000) invalid();
  async function process(candidate, signal) {
    if (candidate?.kind === 'resolved') {
      record(candidate, ['kind','status']);
      if (!['deferred','reconciliation_required'].includes(candidate.status)) invalid();
      return candidate.status;
    }
    let current = lease(candidate, registry);
    let provider;
    try {
      provider = await providers.resolve(current.providerId);
      if (provider) assertCateringProvider(registry.get(current.providerId), provider);
    } catch { provider = null; }
    if (current.kind === 'dispatch' && (signal.aborted || current.mode !== 'api' || !provider)) {
      return repository.defer(current);
    }
    if (current.kind === 'dispatch') {
      const started = await repository.beginDispatch(current);
      if (started === null) return 'obsolete';
      // The returned dispatch lease is independently checked and bound to the
      // candidate. The repository persisted the intent before returning it.
      record(started, ['lease','attempt']);
      if (!Number.isSafeInteger(started.attempt) || started.attempt !== current.job.dispatchAttempts + 1
        || started.attempt > 3 || started.lease !== current) invalid();
      current = { ...current, attempt: started.attempt };
    }
    const scope = { tenantId: current.job.tenantId, integrationId: current.job.integrationId,
      orderId: current.job.orderId, orderVersion: current.job.orderVersion, operation: current.job.operation };
    const idempotencyKey = cateringJobIdempotencyScope(scope);
    let observed;
    try {
      if (!provider || current.mode !== 'api') throw new CateringDeliveryError('unavailable');
      const response = await providerResult((outboundSignal) => provider[
        current.kind === 'dispatch' ? METHODS[current.job.operation] : 'readOrderStatus']({
        ...scope, idempotencyKey, signal: outboundSignal,
        ...(current.kind === 'dispatch' ? { order: current.snapshot, quote: current.quote } : {}) }), signal, providerTimeoutMs);
      let normalized;
      try {
        normalized = normalizeCateringReceipt(response, { orderId: current.job.orderId, orderVersion: current.job.orderVersion,
          positionIds: current.snapshot.positions.map((position) => position.positionId) });
      } catch { throw new CateringDeliveryError('response_invalid'); }
      const { counts: _counts, ...receipt } = normalized;
      observed = { outcome: 'transmitted', retryable: false, failureCode: 'none', receipt, status: 'succeeded', delayMs: null };
    } catch (error) {
      const classified = failure(error);
      if (current.kind === 'reconcile') {
        // An unsuccessful read never proves that an earlier write did not occur.
        // Retain unknown facts and park after ten automatic read admissions.
        observed = { outcome: 'unknown', retryable: false, failureCode: classified.failureCode,
          receipt: null, status: 'reconciliation_required', delayMs: provider && current.mode === 'api'
            && current.job.automaticReconciliationAttempts < 10 ? 60000 : null };
      } else {
        const decision = cateringJobFailureDecision({ attempt: current.attempt, outcome: classified.outcome,
          retryable: classified.retryable, retryAfterMs: classified.retryAfterMs, jitter: jitter() });
        observed = { outcome: classified.outcome, retryable: classified.retryable, failureCode: classified.failureCode,
          receipt: null, status: decision.status, delayMs: decision.status === 'reconciliation_required' ? 60000 : decision.delayMs };
      }
    }
    // Even after cancellation, retain a completed external fact. The worker's
    // stop lifecycle waits for this fenced commit before closing persistence.
    return repository.finish({ lease: current, ...observed });
  }
  return Object.freeze({
    async runBatch({ limit, signal }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 || !(signal instanceof AbortSignal)) invalid();
      const result = { completedCount: 0, deferredCount: 0, reconciliationCount: 0, failedCount: 0 };
      for (let index = 0; index < limit && !signal.aborted; index++) {
        const candidate = await repository.claimNext();
        if (candidate === null) break;
        const status = await process(candidate, signal);
        if (status === 'succeeded') result.completedCount++;
        else if (['deferred','retry_wait','queued'].includes(status)) result.deferredCount++;
        else if (status === 'reconciliation_required') result.reconciliationCount++;
        else if (status === 'failed') result.failedCount++;
        else if (status !== 'obsolete') invalid();
      }
      return Object.freeze(result);
    },
  });
}
