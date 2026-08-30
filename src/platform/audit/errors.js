export class PlatformAuditInputError extends Error {
  constructor(code = 'PLATFORM_AUDIT_EVENT_INVALID') {
    super(code);
    this.name = 'PlatformAuditInputError';
    this.code = code;
  }
}

export class PlatformAuditIntegrityError extends Error {
  constructor(code = 'PLATFORM_AUDIT_INTEGRITY_FAILURE') {
    super(code);
    this.name = 'PlatformAuditIntegrityError';
    this.code = code;
  }
}
