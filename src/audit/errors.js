export class AuditInputError extends Error {
  constructor(code = 'AUDIT_INPUT_INVALID') {
    super(code);
    this.name = 'AuditInputError';
    this.code = code;
  }
}

export class AuditIntegrityError extends Error {
  constructor(code = 'AUDIT_INTEGRITY_FAILED') {
    super(code);
    this.name = 'AuditIntegrityError';
    this.code = code;
  }
}
