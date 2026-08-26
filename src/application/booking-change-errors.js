export class BookingChangeConflictError extends Error {
  constructor(code = 'BOOKING_CHANGE_CONFLICT') {
    super(code);
    this.name = 'BookingChangeConflictError';
    this.code = code;
  }
}

export class BookingChangeDependencyError extends Error {
  constructor(code = 'BOOKING_CHANGE_DEPENDENCY_UNAVAILABLE', options = {}) {
    super(code, options);
    this.name = 'BookingChangeDependencyError';
    this.code = code;
  }
}
