import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCateringOperationalHealth as summarize } from '../src/domain/catering-operational-health.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const instant = '2026-10-19T12:00:00.000Z';
function entry(number, status = 'queued', extra = {}) {
  const attempted = ['dispatching','reconciling','reconciliation_required','succeeded','failed','retry_wait'].includes(status);
  return { job: { tenantId: id(1), jobId: id(number), integrationId: id(3), orderId: id(number + 10000), orderVersion: 1,
    operation: 'initial', revision: 2, status, dispatchAttempts: Number(attempted), automaticReconciliationAttempts: 0,
    quoteRevision: 1, decisionSequence: 1, originStateRevision: 3, createdAt: instant, updatedAt: instant,
    availableAt: ['queued','retry_wait'].includes(status) ? instant : null },
  orderStatus: 'queued', manualSequence: 0, leaseExpired: false, deliveryOperation: 'initial', ...extra };
}
const context = (jobs = [], extra = {}) => ({ tenantId: id(1), integrationId: id(3), connectionAvailable: true,
  tenantBusinessActive: true, processingEnabled: true, observedAt: instant,
  modes: { initial: 'api', change: 'manual', cancel: 'unsupported' }, jobs, ...extra });

test('operational health separates processing, supplier facts, human work and unresolved outcomes without granting authority', () => {
  const replacement = entry(9); replacement.job = { ...replacement.job, operation: 'change', orderVersion: 2 };
  const value = summarize(context([
    entry(1), entry(2,'leased'), entry(3,'succeeded', { orderStatus: 'transmitted' }),
    entry(4,'reconciliation_required', { orderStatus: 'reconciliation_required' }),
    entry(5,'succeeded', { orderStatus: 'partially_confirmed' }), entry(6,'succeeded', { orderStatus: 'confirmed' }),
    entry(7,'failed', { orderStatus: 'failed' }), entry(8,'superseded'), replacement,
    entry(10,'deferred'), entry(11,'queued', { orderStatus: 'confirmed', manualSequence: 2 }),
  ]));
  assert.equal(value.state, 'attention'); assert.equal(value.counts.queued, 2);
  assert.equal(value.counts.processing, 1); assert.equal(value.counts.awaiting_confirmation, 1);
  assert.equal(value.counts.reconciliation, 1); assert.equal(value.counts.conflict, 1);
  assert.equal(value.counts.settled, 2); assert.equal(value.counts.failed, 1);
  assert.equal(value.counts.superseded, 1); assert.equal(value.counts.paused, 1);
  assert.equal(value.oldestOpenAt, instant); assert.equal(Object.isFrozen(value.counts), true);
  assert.doesNotMatch(JSON.stringify(value), /jobId|orderId|tenantId|leaseId|cost|credential|reference/);
});

test('manual confirmation is not an unsent backlog and terminal processing is not global supplier confirmation', () => {
  for (const status of ['queued','deferred','superseded']) {
    const complete = summarize(context([entry(1,status, { orderStatus: 'confirmed', manualSequence: 2 })]));
    assert.equal(complete.counts.settled, 1); assert.equal(complete.state, 'idle');
    const waiting = summarize(context([entry(1,status, { orderStatus: 'transmitted', manualSequence: 1 })]));
    assert.equal(waiting.counts.awaiting_confirmation, 1); assert.equal(waiting.state, 'working');
  }
  const manual = summarize(context([entry(1)], { modes: { initial: 'manual', change: 'manual', cancel: 'manual' } }));
  assert.equal(manual.state, 'manual_action'); assert.equal(manual.counts.manual_action, 1);
  for (const extra of [{ processingEnabled: false }, { connectionAvailable: false }, { tenantBusinessActive: false },
    { modes: { initial: 'unsupported', change: 'unsupported', cancel: 'unsupported' } }]) {
    assert.equal(summarize(context([], extra)).state, 'disabled');
  }
  const expired = summarize(context([entry(1,'leased', { leaseExpired: true })]));
  assert.equal(expired.state, 'attention'); assert.equal(expired.expiredLeaseCount, 1);
});

test('bounded coverage never reports an incomplete sample as idle and validates the extra row without exposing it', () => {
  const jobs = Array.from({ length: 1001 }, (_, index) => entry(index + 1,'succeeded', { orderStatus: 'confirmed' }));
  const value = summarize(context(jobs));
  assert.deepEqual(value.coverage, { limit: 1000, complete: false });
  assert.equal(value.counts.settled, 1000); assert.equal(value.state, 'incomplete'); assert.equal(value.oldestOpenAt, null);
  const complete = summarize(context(jobs.slice(0,1000))); assert.equal(complete.coverage.complete, true);
  assert.equal(complete.state, 'idle');
  jobs.at(-1).job.tenantId = id(99); assert.throws(() => summarize(context(jobs)), /INVALID/);
});

test('foreign scope, malformed records, unknown modes, impossible evidence and accessors fail closed', () => {
  for (const corrupt of [context([entry(1),entry(1)]), context([entry(1,'succeeded')]),
    context([entry(1,'queued', { leaseExpired: true })]),
    context([entry(1,'leased', { orderStatus: 'confirmed', manualSequence: 2, leaseExpired: true })]),
    context([entry(1,'succeeded', { manualSequence: 1 })]),
    context([entry(1,'queued', { deliveryOperation: 'change' })]), context([], { connectionAvailable: 'true' }),
    context([], { processingEnabled: 'true' }),
    context([], { observedAt: '2026-02-30T12:00:00.000Z' }),
    context([], { modes: { initial: 'invented', change: 'manual', cancel: 'unsupported' } }),
    context(Array.from({ length: 1002 }, (_, index) => entry(index + 1))),
    context([entry(1,'queued', { orderStatus: 'unknown' })]), context([entry(1)], { tenantId: id(99) })]) {
    assert.throws(() => summarize(corrupt), /INVALID/);
  }
  let reads = 0; const value = context();
  Object.defineProperty(value, 'jobs', { enumerable: true, get() { reads++; return []; } });
  assert.throws(() => summarize(value), /INVALID/); assert.equal(reads, 0);
});
