import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringJobProcessor } from '../src/application/catering-job-processor.js';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { CateringDeliveryError } from '../src/integrations/catering-contract.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { cateringId as id, cateringOrderFixture } from './support/catering-order-fixture.js';

function fixture({ kind = 'dispatch', attempt = 0, reads = 0, mode = 'api', provider = true, response = 'valid',
  thrown = null, begin = true, cancelledAfterCall = false, hanging = false, cancelledAfterIntent = false } = {}) {
  const [snapshot] = createCateringOrderSnapshots(cateringOrderFixture());
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [{ id: 'synthetic_caterer', runtime: 'production',
    capabilities: { 'catering.order': 'api', 'catering.status': 'api' } }] });
  const candidate = { kind, leaseId: id(90), providerId: 'synthetic_caterer', mode, snapshot,
    quote: { revision: 1, cost: { amountMinor: 1200, currency: 'EUR' } },
    job: { tenantId: snapshot.tenantId, jobId: id(91), integrationId: snapshot.integrationId, orderId: snapshot.orderId,
      orderVersion: 1, operation: 'initial', revision: 2, status: kind === 'dispatch' ? 'leased' : 'reconciling',
      dispatchAttempts: attempt, automaticReconciliationAttempts: reads, quoteRevision: 1, decisionSequence: 1, originStateRevision: 3,
      createdAt: '2026-10-19T12:00:00.000Z', updatedAt: '2026-10-19T12:00:00.000Z', availableAt: null } };
  const calls = []; let consumed = false; const controller = new AbortController();
  const repository = {
    async claimNext() { calls.push('claim'); if (consumed) return null; consumed = true; return candidate; },
    async beginDispatch(lease) {
      calls.push('intent'); if (cancelledAfterIntent) controller.abort();
      return begin ? { lease, attempt: lease.job.dispatchAttempts + 1 } : null;
    },
    async defer() { calls.push('defer'); return 'deferred'; },
    async finish(value) { calls.push({ finish: value }); return value.status; },
  };
  const invoke = async (value) => {
    calls.push({ provider: value }); if (hanging) return new Promise(() => {});
    if (cancelledAfterCall) controller.abort();
    if (thrown) throw thrown;
    if (response !== 'valid') return response;
    return { orderId: snapshot.orderId, orderVersion: 1,
      positions: snapshot.positions.map((position) => ({ positionId: position.positionId, outcome: 'pending' })) };
  };
  const processor = createCateringJobProcessor({ repository, registry, jitter: () => 0, providerTimeoutMs: 10,
    providers: { async resolve() { return provider ? { placeOrder: invoke, readOrderStatus: invoke } : null; } } });
  return { processor, repository, candidate, calls, controller,
    run: () => processor.runBatch({ limit: 25, signal: controller.signal }) };
}

test('dispatch persists intent before provider I/O and commits normalized factual receipt without false global confirmation', async () => {
  const f = fixture(); const counts = await f.run();
  assert.equal(counts.completedCount, 1); assert.equal(f.calls[0], 'claim'); assert.equal(f.calls[1], 'intent');
  assert.ok(f.calls[2].provider); assert.equal(f.calls[3].finish.outcome, 'transmitted');
  assert.equal(f.calls[3].finish.receipt.positions[0].outcome, 'pending');
  assert.equal(Object.hasOwn(f.calls[3].finish.receipt, 'counts'), false);
  assert.match(f.calls[2].provider.idempotencyKey, /^catering-v1:/);
  assert.equal(f.calls[2].provider.tenantId, f.candidate.job.tenantId);
});

test('manual, missing adapter and invalidated source never invoke provider writes', async () => {
  for (const options of [{ mode: 'manual' }, { mode: 'unsupported' }, { provider: false }]) {
    const f = fixture(options); assert.equal((await f.run()).deferredCount, 1);
    assert.deepEqual(f.calls, ['claim','defer','claim']);
  }
  const invalidated = fixture({ begin: false }); const counts = await invalidated.run();
  assert.equal(counts.completedCount, 0); assert.deepEqual(invalidated.calls, ['claim','intent','claim']);
});

test('only typed proven not-sent failures can retry and attempt3 cannot create attempt4', async () => {
  const retry = fixture({ thrown: new CateringDeliveryError('unavailable', { outcome: 'not_sent', retryable: true }) });
  assert.equal((await retry.run()).deferredCount, 1);
  assert.equal(retry.calls[3].finish.status, 'retry_wait'); assert.equal(retry.calls[3].finish.delayMs, 1000);
  const exhausted = fixture({ attempt: 2,
    thrown: new CateringDeliveryError('unavailable', { outcome: 'not_sent', retryable: true }) });
  assert.equal((await exhausted.run()).failedCount, 1); assert.equal(exhausted.calls[3].finish.status, 'failed');
});

test('unknown writes and malformed acknowledgements always reconcile, including exhausted write budget', async () => {
  for (const options of [{ attempt: 2, thrown: new Error('private provider payload') },
    { response: { orderId: id(99), positions: [] } },
    { thrown: Object.assign(new Error('invented proof'), { outcome: 'not_sent', retryable: true }) }]) {
    const f = fixture(options); assert.equal((await f.run()).reconciliationCount, 1);
    const observed = f.calls[3].finish; assert.equal(observed.outcome, 'unknown'); assert.equal(observed.delayMs, 60000);
    assert.doesNotMatch(JSON.stringify(observed), /private provider payload|invented proof/);
  }
});

test('reconciliation performs read-only I/O and unsuccessful reads cannot prove earlier non-delivery', async () => {
  for (const reads of [1,10]) {
    const f = fixture({ kind: 'reconcile', attempt: 3, reads,
      thrown: new CateringDeliveryError('unavailable', { outcome: 'not_sent', retryable: true }) });
    assert.equal((await f.run()).reconciliationCount, 1);
    assert.equal(f.calls.includes('intent'), false);
    assert.equal(Object.hasOwn(f.calls[1].provider, 'order'), false);
    assert.equal(Object.hasOwn(f.calls[1].provider, 'quote'), false);
    const observed = f.calls[2].finish;
    assert.equal(observed.outcome, 'unknown'); assert.equal(observed.retryable, false);
    assert.equal(observed.delayMs, reads === 10 ? null : 60000);
  }
});

test('shutdown stops new claims but preserves already observed external facts through fenced finish', async () => {
  const idle = fixture(); idle.controller.abort(); assert.equal((await idle.run()).completedCount, 0); assert.deepEqual(idle.calls, []);
  const inFlight = fixture({ cancelledAfterCall: true }); assert.equal((await inFlight.run()).completedCount, 1);
  assert.equal(inFlight.calls.at(-1).finish.outcome, 'transmitted');
  assert.equal(inFlight.calls.filter((value) => value === 'claim').length, 1);
});


test('a provider that ignores cancellation is bounded and retained as unknown rather than retried', async () => {
  const f = fixture({ hanging: true }); assert.equal((await f.run()).reconciliationCount, 1);
  assert.equal(f.calls[3].finish.outcome, 'unknown'); assert.equal(f.calls[3].finish.failureCode, 'timeout');
  assert.equal(f.calls.filter((value) => value === 'intent').length, 1);
  assert.equal(f.calls[2].provider.signal.aborted, true);
});


test('shutdown after committed intent but before I/O records proven not-sent without calling the provider', async () => {
  const f = fixture({ cancelledAfterIntent: true }); assert.equal((await f.run()).deferredCount, 1);
  assert.equal(f.calls.some((value) => value.provider), false);
  assert.equal(f.calls.at(-1).finish.outcome, 'not_sent'); assert.equal(f.calls.at(-1).finish.status, 'retry_wait');
});
