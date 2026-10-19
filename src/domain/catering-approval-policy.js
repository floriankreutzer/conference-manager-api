import { isInternalUuid } from './identifiers.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';

export const CATERING_INITIAL_ORDER_MODE = Object.freeze({
  AFTER_CONFERENCE_APPROVAL: 'after_conference_approval',
  MANAGER_REVIEW: 'manager_review',
});

const INITIAL_MODES = new Set(Object.values(CATERING_INITIAL_ORDER_MODE));
const OPERATIONS = new Set(['initial', 'change', 'cancel', 'exception']);

// This determines the required business decision, never whether an actor is authorized or has approved.
export function cateringReviewRequirement(initialOrderMode, operation) {
  if (!INITIAL_MODES.has(initialOrderMode) || !OPERATIONS.has(operation)) {
    throw new TypeError('CATERING_APPROVAL_POLICY_INVALID');
  }
  return operation === 'initial' && initialOrderMode === CATERING_INITIAL_ORDER_MODE.AFTER_CONFERENCE_APPROVAL
    ? 'conference_approval' : 'manager_review';
}
function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('CATERING_COST_APPROVAL_INVALID');
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) throw new TypeError('CATERING_COST_APPROVAL_INVALID');
}

function cost(value) {
  exactRecord(value, ['amountMinor', 'currency']);
  return normalizeCateringOrderTotal(value);
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('CATERING_COST_APPROVAL_INVALID');
}

export function cateringExtraCostReviewRequirement(originalCost, quotedCost) {
  const original = cost(originalCost);
  const quoted = cost(quotedCost);
  return original.currency !== quoted.currency || quoted.amountMinor > original.amountMinor
    ? 'manager_review' : 'no_extra_cost';
}

// All three inputs come from the authorized use case's persisted, independently loaded records.
// Matching evidence is necessary, never sufficient for actor authorization, expiry or order release.
export function cateringQuoteHasCurrentApproval(quote, approval, expected) {
  const scopeKeys = ['tenantId', 'integrationId', 'orderId', 'orderVersion'];
  exactRecord(expected, scopeKeys);
  if (![expected.tenantId, expected.integrationId, expected.orderId].every(isInternalUuid)) {
    throw new TypeError('CATERING_COST_APPROVAL_INVALID');
  }
  positiveVersion(expected.orderVersion);
  exactRecord(quote, ['revision', 'cost']);
  positiveVersion(quote.revision);
  const quotedCost = cost(quote.cost);
  if (approval === null) return false;
  exactRecord(approval, [...scopeKeys, 'quoteRevision', 'cost', 'decision', 'deciderUserId']);
  if (![approval.tenantId, approval.integrationId, approval.orderId, approval.deciderUserId].every(isInternalUuid)
    || !['approved', 'rejected'].includes(approval.decision)) throw new TypeError('CATERING_COST_APPROVAL_INVALID');
  positiveVersion(approval.orderVersion);
  positiveVersion(approval.quoteRevision);
  const approvedCost = cost(approval.cost);
  return approval.decision === 'approved'
    && scopeKeys.every((key) => approval[key] === expected[key])
    && approval.quoteRevision === quote.revision
    && approvedCost.amountMinor === quotedCost.amountMinor
    && approvedCost.currency === quotedCost.currency;
}
