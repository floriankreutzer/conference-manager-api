export class CateringAvailabilityInputError extends Error {
  constructor() { super('CATERING_AVAILABILITY_INPUT_INVALID'); this.name='CateringAvailabilityInputError'; this.code=this.message; }
}
const CONFLICTS=new Set(['REVISION_CONFLICT','REQUEST_CONFLICT','ROUND_CONFLICT','CONFIGURATION_CONFLICT','PUBLICATION_CONFLICT',
  'SOURCE_CONFLICT','COMMAND_CONFLICT','SOURCE_UNAVAILABLE','QUERY_ALREADY_OBSERVED','REVISION_EXHAUSTED','NOT_REQUIRED']);
export class CateringAvailabilityConflictError extends Error {
  constructor(kind) {
    if (!CONFLICTS.has(kind)) throw new TypeError('CATERING_AVAILABILITY_CONFLICT_INVALID');
    super(`CATERING_AVAILABILITY_${kind}`); this.name='CateringAvailabilityConflictError'; this.code=this.message;
  }
}
