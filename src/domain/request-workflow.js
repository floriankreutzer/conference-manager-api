export const REQUEST_STATUS = Object.freeze({
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In Review',
  CONFIRMED: 'Confirmed',
  REJECTED: 'Rejected',
  CHANGE_REQUESTED: 'Change Requested',
  CANCELLED: 'Cancelled',
});

export const REQUEST_TRANSITION = Object.freeze({
  START_REVIEW: 'start_review',
  CONFIRM: 'confirm',
  REJECT: 'reject',
  REQUEST_CHANGE: 'request_change',
  CANCEL: 'cancel',
});

const REQUEST_STATUSES = new Set(Object.values(REQUEST_STATUS));
const REQUEST_TRANSITIONS = new Set(Object.values(REQUEST_TRANSITION));

export function isRequestStatus(value) {
  return REQUEST_STATUSES.has(value);
}

export function isRequestTransition(value) {
  return REQUEST_TRANSITIONS.has(value);
}
