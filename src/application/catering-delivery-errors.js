const CONFLICTS = new Set(['CATERING_DELIVERY_REVISION_CONFLICT','CATERING_DELIVERY_ORDER_CHANGED',
  'CATERING_DELIVERY_ALREADY_ENQUEUED','CATERING_DELIVERY_APPROVAL_UNAVAILABLE']);
export class CateringDeliveryInputError extends Error {
  constructor() { super('CATERING_DELIVERY_INPUT_INVALID'); this.name = 'CateringDeliveryInputError'; }
}
export class CateringDeliveryConflictError extends Error {
  constructor(code) {
    if (!CONFLICTS.has(code)) throw new TypeError('CATERING_DELIVERY_CONFLICT_INVALID');
    super(code); this.name = 'CateringDeliveryConflictError'; this.code = code;
  }
}
