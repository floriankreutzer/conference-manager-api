import { isInternalUuid } from './identifiers.js';
import { normalizeCateringDeliveryJob } from './catering-delivery-job.js';
import { isCateringOrderStatus } from './catering-order-state.js';

export const CATERING_HEALTH_SAMPLE_LIMIT = 1000;
const PHASES = ['queued','processing','awaiting_confirmation','manual_action','reconciliation','conflict',
  'settled','failed','superseded','paused'];
function invalid() { throw new TypeError('CATERING_OPERATIONAL_HEALTH_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function entries(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > CATERING_HEALTH_SAMPLE_LIMIT + 1
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
function phase({ job, orderStatus, manualSequence, deliveryOperation }, modes) {
  // A manual receipt settles business work while the zero-attempt processing
  // job may still be queued/deferred. Such work is not an unsent backlog.
  if (manualSequence > 0 || job.status === 'succeeded') {
    if (['confirmed','cancelled'].includes(orderStatus)) return 'settled';
    if (['partially_confirmed','rejected'].includes(orderStatus)) return 'conflict';
    if (orderStatus === 'transmitted') return 'awaiting_confirmation';
    invalid();
  }
  if (job.status === 'superseded') return 'superseded';
  if (['reconciliation_required','reconciling'].includes(job.status)) return 'reconciliation';
  if (['leased','dispatching'].includes(job.status)) return 'processing';
  if (job.status === 'failed') return 'failed';
  if (!['queued','retry_wait','deferred'].includes(job.status) || !['queued','failed'].includes(orderStatus)) invalid();
  const mode = modes[deliveryOperation === 'exception' ? 'change' : deliveryOperation];
  if (mode === 'manual') return 'manual_action';
  if (mode === 'unsupported' || job.status === 'deferred') return 'paused';
  return 'queued';
}

// Bounded evidence summary, never a provider reachability probe or permission to
// retry, deliver, approve, cancel or discard an unresolved supplier commitment.
export function summarizeCateringOperationalHealth(value) {
  record(value, ['tenantId','integrationId','connectionAvailable','tenantBusinessActive','observedAt','modes','jobs','processingEnabled']);
  if (!isInternalUuid(value.tenantId) || !isInternalUuid(value.integrationId)
    || typeof value.connectionAvailable !== 'boolean' || typeof value.tenantBusinessActive !== 'boolean'
    || typeof value.processingEnabled !== 'boolean') invalid();
  const observedAt = instant(value.observedAt);
  record(value.modes, ['initial','change','cancel']);
  if (!Object.values(value.modes).every((mode) => ['api','manual','unsupported'].includes(mode))) invalid();
  const counts = Object.fromEntries(PHASES.map((name) => [name,0]));
  let oldestOpenAt = null; let expiredLeaseCount = 0; const ids = new Set();
  const jobs = entries(value.jobs);
  for (const [index, entry] of jobs.entries()) {
    record(entry, ['job','orderStatus','manualSequence','leaseExpired','deliveryOperation']);
    const job = normalizeCateringDeliveryJob(entry.job, { tenantId: value.tenantId });
    if (job.integrationId !== value.integrationId || ids.has(job.jobId) || !isCateringOrderStatus(entry.orderStatus)
      || !Number.isSafeInteger(entry.manualSequence) || entry.manualSequence < 0 || entry.manualSequence >= Number.MAX_SAFE_INTEGER
      || typeof entry.leaseExpired !== 'boolean'
      || !['initial','change','cancel','exception'].includes(entry.deliveryOperation)
      || (entry.deliveryOperation !== job.operation && !(entry.deliveryOperation === 'initial'
        && job.operation === 'change' && job.orderVersion > 1))
      || (entry.leaseExpired && !['leased','dispatching','reconciling'].includes(job.status))
      || (entry.manualSequence > 0 && (job.dispatchAttempts !== 0
        || !['queued','deferred','superseded'].includes(job.status)))) invalid();
    ids.add(job.jobId);
    const selected = phase({ ...entry, job }, value.modes);
    if (index >= CATERING_HEALTH_SAMPLE_LIMIT) continue;
    counts[selected]++;
    if (entry.leaseExpired) expiredLeaseCount++;
    if (!['settled','superseded'].includes(selected) && (oldestOpenAt === null || job.createdAt < oldestOpenAt)) {
      oldestOpenAt = job.createdAt;
    }
  }
  const complete = jobs.length <= CATERING_HEALTH_SAMPLE_LIMIT;
  const dispatchEnabled = value.processingEnabled && Object.values(value.modes).some((mode) => mode !== 'unsupported');
  const attention = counts.reconciliation + counts.conflict + counts.failed + counts.paused + expiredLeaseCount > 0;
  const state = attention ? 'attention' : !value.connectionAvailable || !value.tenantBusinessActive || !dispatchEnabled ? 'disabled'
    : !complete ? 'incomplete' : counts.manual_action > 0 ? 'manual_action'
      : counts.queued + counts.processing + counts.awaiting_confirmation > 0 ? 'working' : 'idle';
  return Object.freeze({ observedAt, state, dispatchEnabled,
    availability: Object.freeze({ connection: value.connectionAvailable, tenantBusiness: value.tenantBusinessActive }),
    coverage: Object.freeze({ limit: CATERING_HEALTH_SAMPLE_LIMIT, complete }), counts: Object.freeze(counts),
    expiredLeaseCount, oldestOpenAt });
}
