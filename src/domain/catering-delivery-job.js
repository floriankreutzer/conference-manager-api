import { isInternalUuid } from './identifiers.js';
import { cateringJobIdempotencyScope } from './catering-job-policy.js';

const STATUSES = new Set(['queued','leased','dispatching','reconciling','retry_wait','deferred',
  'reconciliation_required','succeeded','failed','superseded']);
const KEYS = ['tenantId','jobId','integrationId','orderId','orderVersion','operation','revision','status',
  'dispatchAttempts','automaticReconciliationAttempts','quoteRevision','decisionSequence','originStateRevision',
  'createdAt','updatedAt','availableAt'];
function invalid() { throw new TypeError('CATERING_DELIVERY_JOB_INVALID'); }
function positive(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}

// The bounded read projection intentionally excludes leases, credentials, actors
// and raw supplier payloads. It is not an authority to dispatch a stored job.
export function normalizeCateringDeliveryJob(value, { tenantId, jobId = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== KEYS.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !KEYS.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
  if (!isInternalUuid(tenantId) || value.tenantId !== tenantId
    || !isInternalUuid(value.jobId) || (jobId !== null && value.jobId !== jobId)) invalid();
  cateringJobIdempotencyScope({ tenantId, integrationId: value.integrationId, orderId: value.orderId,
    orderVersion: value.orderVersion, operation: value.operation });
  if (!STATUSES.has(value.status)) invalid();
  positive(value.revision); positive(value.quoteRevision); positive(value.decisionSequence);
  positive(value.originStateRevision, 1, Number.MAX_SAFE_INTEGER - 2);
  positive(value.dispatchAttempts, 0, 3); positive(value.automaticReconciliationAttempts, 0, 10);
  instant(value.createdAt); instant(value.updatedAt);
  if (value.availableAt !== null) instant(value.availableAt);
  if (value.updatedAt < value.createdAt || (['queued','retry_wait'].includes(value.status)
    && (value.availableAt === null || value.dispatchAttempts === 3))) invalid();
  if (['dispatching','reconciling','reconciliation_required','succeeded','failed'].includes(value.status)
    && value.dispatchAttempts === 0) invalid();
  return Object.freeze({ ...value });
}
