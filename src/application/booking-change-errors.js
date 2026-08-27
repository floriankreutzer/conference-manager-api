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

export const BOOKING_CHANGE_MOVE_RECOVERY = Object.freeze({
  RETRY_SAME_ATTEMPT: 'retry_same_attempt',
  RETRY_NEW_ATTEMPT: 'retry_new_attempt',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
});

const MOVE_RECOVERY_VALUES = new Set(Object.values(BOOKING_CHANGE_MOVE_RECOVERY));

export class BookingChangeCalendarMoveError extends Error {
  constructor(recovery, { calendarReplacement = null, ...options } = {}) {
    if (!MOVE_RECOVERY_VALUES.has(recovery)) throw new TypeError('BOOKING_CHANGE_MOVE_RECOVERY_INVALID');
    super('BOOKING_CHANGE_CALENDAR_MOVE_FAILED', options);
    this.name = 'BookingChangeCalendarMoveError';
    this.code = 'BOOKING_CHANGE_CALENDAR_MOVE_FAILED';
    this.recovery = recovery;
    this.calendarReplacement = calendarReplacement;
  }
}
