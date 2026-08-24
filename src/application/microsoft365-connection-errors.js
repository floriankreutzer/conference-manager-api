export class Microsoft365ConnectionInputError extends Error {
  constructor(code = 'MICROSOFT365_CONNECTION_INPUT_INVALID') {
    super(code);
    this.name = 'Microsoft365ConnectionInputError';
    this.code = code;
  }
}

export class Microsoft365ConnectionConflictError extends Error {
  constructor(code = 'MICROSOFT365_CONNECTION_CONFLICT') {
    super(code);
    this.name = 'Microsoft365ConnectionConflictError';
    this.code = code;
  }
}

export class Microsoft365ConnectionUnavailableError extends Error {
  constructor(code = 'MICROSOFT365_CONNECTION_UNAVAILABLE') {
    super(code);
    this.name = 'Microsoft365ConnectionUnavailableError';
    this.code = code;
  }
}
