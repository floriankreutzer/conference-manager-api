import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';
import { capabilityForCateringOrderOperation } from './catering-order-state.js';

function invalid() { throw new TypeError('CATERING_RECEIPT_STATE_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid();
  return value;
}

// Receipt counts come from a complete, scope-validated immutable position set.
// This derives presentation/business state, never provider or Manager authority.
export function cateringOrderStateFromReceipt({ operation, positionCount, counts } = {}) {
  capabilityForCateringOrderOperation(operation);
  if (!Number.isSafeInteger(positionCount) || positionCount < 1 || positionCount > CATERING_MAX_ORDER_POSITIONS) invalid();
  record(counts, ['confirmed','rejected','pending','substitution_proposed']);
  const values = Object.values(counts);
  if (values.some((count) => !Number.isSafeInteger(count) || count < 0 || count > positionCount)
    || values.reduce((sum, count) => sum + count, 0) !== positionCount) invalid();
  if (counts.confirmed === positionCount) return operation === 'cancel' ? 'cancelled' : 'confirmed';
  if (counts.confirmed > 0) return 'partially_confirmed';
  return counts.rejected === positionCount ? 'rejected' : 'transmitted';
}

// Necessary factual progression only: a separately authorized use case must
// prove the exact approved immutable version/quote and receipt before using it.
// Pending, partial, rejected or substitution proposals never replace an effective
// earlier version; late old confirmations cannot roll a newer effective one back.
export function effectiveCateringVersionAfterReceipt(current, candidate) {
  if (current !== null) {
    record(current, ['orderVersion','status']); version(current.orderVersion);
    if (!['confirmed','cancelled'].includes(current.status)) invalid();
  }
  record(candidate, ['orderVersion','operation','positionCount','counts']); version(candidate.orderVersion);
  const status = cateringOrderStateFromReceipt(candidate);
  if (!['confirmed','cancelled'].includes(status) || (current && current.orderVersion >= candidate.orderVersion)) {
    return current === null ? null : Object.freeze({ ...current });
  }
  return Object.freeze({ orderVersion: candidate.orderVersion, status });
}
