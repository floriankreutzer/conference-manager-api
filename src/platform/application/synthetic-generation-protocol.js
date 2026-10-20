import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeSyntheticGenerationIntent,SYNTHETIC_GENERATION_RETENTION_LIMIT } from '../../domain/synthetic-generation-lifecycle.js';
import { normalizeSyntheticGenerationDirectory } from '../../domain/synthetic-generation-directory.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';

export function createSyntheticGenerationProtocol({ generationService,directory,passkeyService,withPreparationScope }={}) {
  if (['operationHash','replace'].some(name=>typeof generationService?.[name]!=='function') || typeof directory?.current!=='function'
    || ['startStepUp','executeStepUp'].some(name=>typeof passkeyService?.[name]!=='function') || typeof withPreparationScope!=='function') {
    throw new TypeError('SYNTHETIC_GENERATION_PROTOCOL_CONFIGURATION_INVALID');
  }
  function authority(input) {
    const principal=normalizePlatformPrincipal(input?.principal),intent=normalizeSyntheticGenerationIntent(input?.intent);
    if (principal.operatorId!==intent.operatorId || !isInternalUuid(input?.correlationId)) {
      throw new TypeError('SYNTHETIC_GENERATION_PROTOCOL_INPUT_INVALID');
    }
    return { principal,intent,correlationId: input.correlationId };
  }
  return Object.freeze({
    current({ principal }={}) { return withPreparationScope(()=>directory.current(normalizePlatformPrincipal(principal))); },
    options(input) {
      const { principal,intent,correlationId }=authority(input);
      return withPreparationScope(async()=>{
        const view=normalizeSyntheticGenerationDirectory(await directory.current(principal));
        if ((view.generation?.generationId ?? null)!==intent.expectedGenerationId
          || (view.generation?.revision ?? 0)!==intent.expectedRevision) throw new Error('SYNTHETIC_GENERATION_STALE');
        if (!view.canReplace) throw new Error(view.retainedGenerations===SYNTHETIC_GENERATION_RETENTION_LIMIT
          ? 'SYNTHETIC_GENERATION_RETENTION_LIMIT' : 'SYNTHETIC_GENERATION_COOLDOWN');
        return passkeyService.startStepUp(principal,{ operationHash: generationService.operationHash(intent),correlationId });
      });
    },
    async replace(input) {
      const { intent,correlationId }=authority(input);
      // No outer shared lease surrounds the owner-stamped exclusive proof TX.
      // The actual repository rechecks current source, epoch, revision/cooldown
      // and retention. No privileged output is returned before its full COMMIT.
      return passkeyService.executeStepUp({ operationHash: generationService.operationHash(intent),state: input.state,
        cookie: input.cookie,response: input.response,request: input.request },
      proofContext=>generationService.replace({ proofContext,intent,correlationId }));
    },
  });
}
