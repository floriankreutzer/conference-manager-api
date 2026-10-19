const CONFLICTS = new Set(['CATERING_MANUAL_REVISION_CONFLICT','CATERING_MANUAL_COMMAND_CONFLICT',
  'CATERING_MANUAL_APPROVAL_UNAVAILABLE','CATERING_MANUAL_SOURCE_UNAVAILABLE','CATERING_MANUAL_ALREADY_TRANSMITTED',
  'CATERING_MANUAL_TRANSMISSION_REQUIRED','CATERING_MANUAL_TERMINAL_CONFLICT','CATERING_MANUAL_TIME_CONFLICT',
  'CATERING_MANUAL_RECEIPT_CONFLICT']);
export class CateringManualInputError extends Error {
  constructor() { super('CATERING_MANUAL_INPUT_INVALID'); this.name = 'CateringManualInputError'; }
}
export class CateringManualConflictError extends Error {
  constructor(code) {
    if (!CONFLICTS.has(code)) throw new TypeError('CATERING_MANUAL_CONFLICT_INVALID');
    super(code); this.name = 'CateringManualConflictError'; this.code = code;
  }
}
