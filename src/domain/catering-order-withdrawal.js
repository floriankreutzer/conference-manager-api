import { isInternalUuid } from './identifiers.js';
import { isCateringOrderStatus } from './catering-order-state.js';

function invalid() { throw new TypeError('CATERING_WITHDRAWAL_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function count(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }

// A local stop is not a supplier cancellation. Eligibility must be independently
// reconstructed from locked authoritative rows; an input object grants no authority.
export function cateringOrderWithdrawalEligibility(value) {
  record(value, ['orderVersion','status','decision','effective','manualSequence','job']);
  const current = count(value.orderVersion);
  if (!isCateringOrderStatus(value.status) || ![null,'approved','rejected'].includes(value.decision)) invalid();
  count(value.manualSequence, 0);
  if (value.effective !== null) {
    record(value.effective, ['orderVersion','status']);
    if (count(value.effective.orderVersion) > current || !['confirmed','cancelled'].includes(value.effective.status)) invalid();
    if (value.effective.orderVersion === current || value.effective.status === 'cancelled') {
      return Object.freeze({ eligible: false, reason: 'effective_commitment' });
    }
  }
  if (value.manualSequence > 0) return Object.freeze({ eligible: false, reason: 'manual_transmission_recorded' });
  if (value.job !== null) {
    record(value.job, ['status','dispatchAttempts','hasAttempt','hasObservation','leaseActive']);
    if (!['queued','leased','dispatching','reconciling','retry_wait','deferred','reconciliation_required',
      'succeeded','failed','superseded'].includes(value.job.status)
      || !['leaseActive','hasAttempt','hasObservation'].every((key) => typeof value.job[key] === 'boolean')) invalid();
    const attempted = count(value.job.dispatchAttempts, 0) !== 0 || value.job.hasAttempt || value.job.hasObservation;
    if (attempted || value.job.leaseActive || !['queued','deferred'].includes(value.job.status)) {
      return Object.freeze({ eligible: false, reason: 'provider_attempt_or_lease' });
    }
  }
  const pending = ['pending_quote','pending_manager_review','released'].includes(value.status)
    || (value.status === 'rejected' && value.decision === 'rejected');
  if (!((pending && value.job === null) || (value.status === 'queued' && value.job !== null && value.decision === 'approved'))) {
    return Object.freeze({ eligible: false, reason: 'unresolved_or_terminal' });
  }
  return Object.freeze({ eligible: true, retainedEffectiveVersion: value.effective?.orderVersion ?? null });
}

export function normalizeCateringWithdrawalCommand(value, { orderId } = {}) {
  record(value, ['schemaVersion','commandId','expectedOrderVersion','expectedStateRevision','justification','attestNotTransmitted']);
  if (value.schemaVersion !== 1 || value.attestNotTransmitted !== true
    || typeof value.justification !== 'string' || value.justification !== value.justification.trim()
    || value.justification.length < 1 || value.justification.length > 1000 || /[\u0000-\u001f\u007f]/.test(value.justification)) invalid();
  return Object.freeze({ schemaVersion: 1, orderId: uuid(orderId), commandId: uuid(value.commandId),
    expectedOrderVersion: count(value.expectedOrderVersion),
    expectedStateRevision: count(value.expectedStateRevision, 1, Number.MAX_SAFE_INTEGER - 2),
    justification: value.justification, attestNotTransmitted: true });
}

export function normalizeCateringWithdrawalFact(value, { tenantId, orderId } = {}) {
  record(value, ['tenantId','orderId','orderVersion','commandId','originStateRevision','previousStatus','quoteRevision',
    'decisionSequence','jobId','jobRevision','justification','attestNotTransmitted','recordedAt','actorUserId','actorSecurityVersion']);
  const tenant = uuid(tenantId); const order = uuid(orderId);
  const command = normalizeCateringWithdrawalCommand({ schemaVersion: 1, commandId: value.commandId,
    expectedOrderVersion: value.orderVersion, expectedStateRevision: value.originStateRevision,
    justification: value.justification, attestNotTransmitted: value.attestNotTransmitted }, { orderId: order });
  if (value.tenantId !== tenant || value.orderId !== order
    || !['pending_quote','pending_manager_review','released','rejected','queued'].includes(value.previousStatus)
    || (value.decisionSequence !== null && value.quoteRevision === null)
    || (value.jobId === null) !== (value.jobRevision === null)
    || typeof value.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.recordedAt)
    || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) invalid();
  return Object.freeze({ tenantId: tenant, orderId: order, orderVersion: command.expectedOrderVersion,
    commandId: command.commandId, originStateRevision: command.expectedStateRevision, previousStatus: value.previousStatus,
    quoteRevision: value.quoteRevision === null ? null : count(value.quoteRevision),
    decisionSequence: value.decisionSequence === null ? null : count(value.decisionSequence),
    jobId: value.jobId === null ? null : uuid(value.jobId),
    jobRevision: value.jobRevision === null ? null : count(value.jobRevision, 1, Number.MAX_SAFE_INTEGER - 2),
    justification: command.justification, attestNotTransmitted: true, recordedAt: value.recordedAt, actorUserId: uuid(value.actorUserId),
    actorSecurityVersion: count(value.actorSecurityVersion) });
}
