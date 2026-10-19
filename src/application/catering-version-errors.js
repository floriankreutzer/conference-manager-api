const CONFLICTS = new Set(['CATERING_VERSION_REVISION_CONFLICT','CATERING_VERSION_COMMAND_CONFLICT',
  'CATERING_VERSION_REQUEST_CHANGED','CATERING_VERSION_ASSIGNMENT_CHANGED','CATERING_VERSION_SOURCE_UNAVAILABLE']);
export class CateringVersionInputError extends Error {
  constructor() { super('CATERING_VERSION_INPUT_INVALID'); this.name = 'CateringVersionInputError'; this.code = this.message; }
}
export class CateringVersionConflictError extends Error {
  constructor(code) {
    if (!CONFLICTS.has(code)) throw new TypeError('CATERING_VERSION_CONFLICT_INVALID');
    super(code); this.name = 'CateringVersionConflictError'; this.code = code;
  }
}
