import {
  cateringExtraCostReviewRequirement, cateringQuoteHasCurrentApproval, cateringReviewRequirement,
} from './catering-approval-policy.js';
import { normalizeCateringOrderTotal } from './catering-order-money.js';

function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('CATERING_RELEASE_EVIDENCE_INVALID');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) throw new TypeError('CATERING_RELEASE_EVIDENCE_INVALID');
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('CATERING_RELEASE_EVIDENCE_INVALID');
  }
  return Date.parse(value);
}

// A consistency/requirement decision over independently authorized persisted
// evidence. true is not actor authorization, a database mutation or dispatch.
export function evaluateCateringOrderRelease({ initialOrderMode, operation, conferenceApproved,
  originalProviderCost, quote, managerApproval, expected, startsAt, now } = {}) {
  if (typeof conferenceApproved !== 'boolean') throw new TypeError('CATERING_RELEASE_EVIDENCE_INVALID');
  const businessReview = cateringReviewRequirement(initialOrderMode, operation);
  record(quote, ['revision', 'cost', 'expiresAt']);
  const currentTime = instant(now);
  const expiresAt = instant(quote.expiresAt);
  const conferenceStart = instant(startsAt);
  const quotedCost = normalizeCateringOrderTotal(quote.cost);
  const costReview = originalProviderCost === null ? 'manager_review'
    : cateringExtraCostReviewRequirement(originalProviderCost, quotedCost);
  // Validate every supplied approval/scope even if this operation has no extra
  // cost; unknown authority-bearing records must not be silently ignored.
  const approved = cateringQuoteHasCurrentApproval({ revision: quote.revision, cost: quotedCost }, managerApproval, expected);
  const reasons = [];
  // Cancelling an existing supplier order must remain possible after the
  // conference itself is cancelled. The authorized use case must prove that
  // existing order independently; a matching ID is never that proof.
  if (operation !== 'cancel' && !conferenceApproved) reasons.push('conference_not_approved');
  if (operation !== 'cancel' && currentTime >= conferenceStart) reasons.push('conference_started');
  if (currentTime >= expiresAt) reasons.push('quote_expired');
  if ((businessReview === 'manager_review' || costReview === 'manager_review') && !approved) reasons.push('manager_approval_required');
  return Object.freeze({ eligible: reasons.length === 0, businessReview, costReview, reasons: Object.freeze(reasons) });
}
