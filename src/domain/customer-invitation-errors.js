export class CustomerInvitationConflictError extends Error {
  constructor() {
    super('CUSTOMER_INVITATION_CONFLICT');
    this.name = 'CustomerInvitationConflictError';
    this.code = 'CUSTOMER_INVITATION_CONFLICT';
  }
}
