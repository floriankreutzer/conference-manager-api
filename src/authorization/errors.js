export class AuthorizationDeniedError extends Error {
  constructor(code = 'AUTHORIZATION_DENIED', { conceal = false } = {}) {
    super(code);
    this.name = 'AuthorizationDeniedError';
    this.code = code;
    this.conceal = conceal;
  }
}

export class AuthorizationInputError extends Error {
  constructor(code = 'AUTHORIZATION_INPUT_INVALID') {
    super(code);
    this.name = 'AuthorizationInputError';
    this.code = code;
  }
}

export class RequestStateConflictError extends Error {
  constructor(code = 'REQUEST_STATE_CONFLICT') {
    super(code);
    this.name = 'RequestStateConflictError';
    this.code = code;
  }
}
