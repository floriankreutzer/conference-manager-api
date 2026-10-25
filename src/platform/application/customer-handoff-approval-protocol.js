import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeSyntheticHandoffIntent } from '../../domain/synthetic-handoff.js';
import { normalizeOwnerCustomerAccessIntent } from '../../domain/owner-customer-handoff.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';

// Shared orchestration only. The fixed wrapper selects an intent schema; the
// injected root-owned operation instance retains its own transaction class.
// Release preparation before that transaction; a synthetic outer shared lease
// would deadlock its separately stamped exclusive upgrade.
export function createCustomerHandoffApprovalProtocol({ handoffService,operationService,withPreparationScope,kind }={}) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('CUSTOMER_HANDOFF_PROTOCOL_KIND_INVALID');
  const prefix=kind==='synthetic' ? 'SYNTHETIC_HANDOFF' : 'OWNER_CUSTOMER_ACCESS';
  const normalizeIntent=kind==='synthetic' ? normalizeSyntheticHandoffIntent : normalizeOwnerCustomerAccessIntent;
  if (['operationHash','approve'].some(name=>typeof handoffService?.[name]!=='function')
    || ['startStepUp','executeStepUpWithContinuation'].some(name=>typeof operationService?.[name]!=='function')
    || typeof withPreparationScope!=='function') throw new TypeError(`${prefix}_PROTOCOL_CONFIGURATION_INVALID`);
  function authority(input) {
    const principal=normalizePlatformPrincipal(input?.principal),intent=normalizeIntent(input?.intent);
    if (principal.operatorId!==intent.operatorId || !isInternalUuid(input?.correlationId)
      || kind==='owner_real' && Object.hasOwn(input,'response')) {
      throw new TypeError(`${prefix}_PROTOCOL_INPUT_INVALID`);
    }
    return { principal,intent,correlationId: input.correlationId };
  }
  return Object.freeze({
    options(input) {
      const { principal,intent,correlationId }=authority(input);
      return withPreparationScope(async()=>{
        const operationHash=await handoffService.operationHash({ principal,intent });
        return operationService.startStepUp(principal,{ operationHash,correlationId });
      });
    },
    async approve(input) {
      const { principal,intent,correlationId }=authority(input);
      const operationHash=await withPreparationScope(()=>handoffService.operationHash({ principal,intent }));
      // The returned redirect/code and ordinary cookie stay private until this
      // entire call, including proof/mutation/session/audit COMMIT, has resolved.
      return operationService.executeStepUpWithContinuation({ operationHash,cookie: input.cookie,state: input.state,
        ...(kind==='synthetic' ? { response: input.response } : {}),request: input.request },
      proofContext=>handoffService.approve({ proofContext,intent,correlationId }));
    },
  });
}
