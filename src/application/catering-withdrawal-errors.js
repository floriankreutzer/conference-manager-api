export class CateringWithdrawalInputError extends Error {
  constructor() { super('CATERING_WITHDRAWAL_INPUT_INVALID'); this.name = 'CateringWithdrawalInputError'; this.code = this.message; }
}
export class CateringWithdrawalConflictError extends Error {
  constructor(code) {
    if (!['CATERING_WITHDRAWAL_REVISION_CONFLICT','CATERING_WITHDRAWAL_COMMAND_CONFLICT',
      'CATERING_WITHDRAWAL_SOURCE_UNAVAILABLE'].includes(code)) throw new TypeError('CATERING_WITHDRAWAL_CONFLICT_INVALID');
    super(code); this.name = 'CateringWithdrawalConflictError'; this.code = code;
  }
}
