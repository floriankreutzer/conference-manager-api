const CONFLICTS = new Set(['CATERING_ORDER_REVISION_CONFLICT','CATERING_ORDER_REQUEST_CHANGED',
  'CATERING_ORDER_ASSIGNMENT_CHANGED','CATERING_ORDER_ALREADY_PREPARED','CATERING_ORDER_CONNECTION_UNAVAILABLE',
  'CATERING_ORDER_QUOTE_EXPIRED','CATERING_ORDER_QUOTE_UNAVAILABLE','CATERING_ORDER_DELIVERY_IN_PROGRESS',
  'CATERING_ORDER_REVISION_EXHAUSTED','CATERING_ORDER_EMPTY','CATERING_ORDER_MANUAL_QUOTE_UNSUPPORTED','CATERING_ORDER_SCHEDULE_PASSED']);

export class CateringOrderInputError extends Error {
  constructor() {
    super('CATERING_ORDER_INPUT_INVALID');
    this.name = 'CateringOrderInputError';
    this.code = 'CATERING_ORDER_INPUT_INVALID';
  }
}
export class CateringOrderConflictError extends Error {
  constructor(code, currentRevision = null) {
    if (!CONFLICTS.has(code) || (currentRevision !== null && (!Number.isSafeInteger(currentRevision)
      || currentRevision < 0 || currentRevision >= Number.MAX_SAFE_INTEGER))) throw new TypeError('CATERING_ORDER_CONFLICT_INVALID');
    super(code);
    this.name = 'CateringOrderConflictError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}
