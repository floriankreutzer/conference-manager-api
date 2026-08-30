export class PlatformOperationInputError extends Error {
  constructor(code = 'PLATFORM_OPERATION_INPUT_INVALID') {
    super(code);
    this.name = 'PlatformOperationInputError';
    this.code = code;
  }
}

export class PlatformOperationDeniedError extends Error {
  constructor(code = 'PLATFORM_OPERATION_DENIED') {
    super(code);
    this.name = 'PlatformOperationDeniedError';
    this.code = code;
  }
}

export class PlatformOperationConflictError extends Error {
  constructor(code = 'PLATFORM_OPERATION_CONFLICT') {
    super(code);
    this.name = 'PlatformOperationConflictError';
    this.code = code;
  }
}

export class PlatformOperationUnavailableError extends Error {
  constructor(code = 'PLATFORM_OPERATION_UNAVAILABLE') {
    super(code);
    this.name = 'PlatformOperationUnavailableError';
    this.code = code;
  }
}
