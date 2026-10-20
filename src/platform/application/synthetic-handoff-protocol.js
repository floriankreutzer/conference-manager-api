import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeSyntheticHandoffIntent } from '../../domain/synthetic-handoff.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';

// Short preparation uses the owned shared deployment lease. The fresh proof
// completion itself must enter its separately configured owner-stamped exclusive
// transaction; keeping an outer shared lease here would deadlock that upgrade.
export function createSyntheticHandoffProtocol({ handoffService,passkeyService,withPreparationScope }={}) {
  if (['operationHash','approve'].some(name=>typeof handoffService?.[name]!=='function')
    || ['startStepUp','executeStepUpWithContinuation'].some(name=>typeof passkeyService?.[name]!=='function')
    || typeof withPreparationScope!=='function') throw new TypeError('SYNTHETIC_HANDOFF_PROTOCOL_CONFIGURATION_INVALID');
  function authority(input) {
    const principal=normalizePlatformPrincipal(input?.principal),intent=normalizeSyntheticHandoffIntent(input?.intent);
    if (principal.operatorId!==intent.operatorId || !isInternalUuid(input?.correlationId)) {
      throw new TypeError('SYNTHETIC_HANDOFF_PROTOCOL_INPUT_INVALID');
    }
    return { principal,intent,correlationId: input.correlationId };
  }
  return Object.freeze({
    options(input) {
      const { principal,intent,correlationId }=authority(input);
      return withPreparationScope(async()=>{
        const operationHash=await handoffService.operationHash({ principal,intent });
        return passkeyService.startStepUp(principal,{ operationHash,correlationId });
      });
    },
    async approve(input) {
      const { principal,intent,correlationId }=authority(input);
      const operationHash=await withPreparationScope(()=>handoffService.operationHash({ principal,intent }));
      // The returned redirect/code and ordinary cookie stay private until this
      // entire call, including proof/mutation/session/audit COMMIT, has resolved.
      return passkeyService.executeStepUpWithContinuation({ operationHash,cookie: input.cookie,state: input.state,
        response: input.response,request: input.request },
      proofContext=>handoffService.approve({ proofContext,intent,correlationId }));
    },
  });
}
