import { createCustomerHandoffApprovalProtocol } from './customer-handoff-approval-protocol.js';

// Only the owned shared Microsoft instance may be composed here. Browser input
// cannot select synthetic proof authority, execution class or intent schema.
export function createOwnerCustomerAccessProtocol({ handoffService,microsoftOperationService,withPreparationScope }={}) {
  return createCustomerHandoffApprovalProtocol({ handoffService,operationService: microsoftOperationService,
    withPreparationScope,kind: 'owner_real' });
}
