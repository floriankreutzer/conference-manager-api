import { isInternalUuid } from './identifiers.js';
import { capabilityForCateringOrderOperation } from './catering-order-state.js';

const STATES = new Set(['queued','leased','dispatching','reconciling','retry_wait','deferred',
  'reconciliation_required','succeeded','failed','superseded']);
function invalid() { throw new TypeError('CATERING_JOB_SCOPE_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }

// These references must be loaded from the authorized durable order, never used
// to authorize it. One key binds exactly one Tenant/connection/order/version/op.
export function cateringJobIdempotencyScope(value) {
  record(value, ['tenantId','integrationId','orderId','orderVersion','operation']);
  if (!Number.isSafeInteger(value.orderVersion) || value.orderVersion < 1
    || value.orderVersion >= Number.MAX_SAFE_INTEGER) invalid();
  capabilityForCateringOrderOperation(value.operation);
  if ((value.orderVersion === 1) !== (value.operation === 'initial')) invalid();
  return ['catering-v1', uuid(value.tenantId), uuid(value.integrationId), uuid(value.orderId),
    String(value.orderVersion), value.operation].join(':');
}

// Only a durable pre-dispatch lease can return to queued. Once dispatch intent
// exists, lease loss/crash is ambiguous even when the attempt budget is exhausted.
export function cateringJobLeaseRecovery({ status, leaseExpired } = {}) {
  if (!STATES.has(status) || typeof leaseExpired !== 'boolean') throw new TypeError('CATERING_JOB_RECOVERY_INVALID');
  if (!leaseExpired) return null;
  if (status === 'leased') return 'queued';
  if (status === 'dispatching' || status === 'reconciling') return 'reconciliation_required';
  return null;
}
