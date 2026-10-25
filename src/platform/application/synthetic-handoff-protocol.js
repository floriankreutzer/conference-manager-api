import { createCustomerHandoffApprovalProtocol } from './customer-handoff-approval-protocol.js';

// Preserve the existing contract; callers cannot select the owner profile.
export function createSyntheticHandoffProtocol({ handoffService,passkeyService,withPreparationScope }={}) {
  return createCustomerHandoffApprovalProtocol({ handoffService,operationService: passkeyService,
    withPreparationScope,kind: 'synthetic' });
}
