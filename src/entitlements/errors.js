export class EntitlementInputError extends Error {
  constructor(code = 'ENTITLEMENT_INPUT_INVALID') {
    super(code);
    this.name = 'EntitlementInputError';
    this.code = code;
  }
}

export class EntitlementDeniedError extends Error {
  constructor(code = 'ENTITLEMENT_ACCESS_DENIED') {
    super(code);
    this.name = 'EntitlementDeniedError';
    this.code = code;
  }
}
