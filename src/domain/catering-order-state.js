export const CATERING_ORDER_STATUSES = Object.freeze(['pending_quote','pending_manager_review','released','queued',
  'dispatching','reconciliation_required','transmitted','confirmed','partially_confirmed','rejected','cancelled','failed','withdrawn']);

export function isCateringOrderStatus(value) { return CATERING_ORDER_STATUSES.includes(value); }

// Quotes and decisions cannot overwrite delivery evidence. A later change or
// supplier exception needs its own reviewed version rather than editing the
// quote attached to an in-flight or confirmed version.
export function canRecordCateringOrderQuote(status, decision = null) {
  return ['pending_quote','pending_manager_review','released'].includes(status)
    || (status === 'rejected' && decision === 'rejected');
}
export function canDecideCateringOrderQuote(status, decision = null) {
  return ['pending_manager_review','released'].includes(status)
    || (status === 'rejected' && decision === 'rejected');
}
export function capabilityForCateringOrderOperation(operation) {
  const capabilities = { initial: 'catering.order', change: 'catering.update', cancel: 'catering.cancel', exception: 'catering.update' };
  if (!Object.hasOwn(capabilities, operation)) throw new TypeError('CATERING_ORDER_OPERATION_INVALID');
  return capabilities[operation];
}
