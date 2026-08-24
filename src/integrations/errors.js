export class BookingIntegrationError extends Error {
  constructor(code, { operation = 'unknown', retryable = false, retryAfterMs = null } = {}) {
    super(code);
    this.name = 'BookingIntegrationError';
    this.code = code;
    this.operation = operation;
    this.retryable = retryable === true;
    this.retryAfterMs = retryAfterMs;
  }
}

export class BookingIntegrationInputError extends BookingIntegrationError {
  constructor(code = 'BOOKING_INTEGRATION_INPUT_INVALID') {
    super(code, { operation: 'validation' });
    this.name = 'BookingIntegrationInputError';
  }
}

export class BookingIntegrationDeniedError extends BookingIntegrationError {
  constructor(code = 'BOOKING_INTEGRATION_NOT_AUTHORIZED') {
    super(code, { operation: 'authorization' });
    this.name = 'BookingIntegrationDeniedError';
  }
}

export class BookingReferenceConflictError extends BookingIntegrationError {
  constructor(code = 'BOOKING_PROVIDER_REFERENCE_CONFLICT') {
    super(code, { operation: 'persistence' });
    this.name = 'BookingReferenceConflictError';
  }
}
