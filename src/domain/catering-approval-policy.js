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
