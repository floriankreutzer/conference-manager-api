import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_ENTRA_PROVIDER } from '../../domain/identity-provider.js';
import { normalizeSyntheticGenerationIntent,syntheticGenerationOperationHash } from '../../domain/synthetic-generation-lifecycle.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { syntheticOperationAssurance } from '../../domain/synthetic-operation-assurance.js';

// The opaque proof context is issued/consumed by the existing exact-operation
// passkey service. An intent, hash or ordinary elevated principal is not proof.
export function createSyntheticGenerationService({ repository,passkeyService,authorizationPolicy,environment,securityEpoch,
  assuranceMode='application_passkey' }={}) {
  const assurance=syntheticOperationAssurance(assuranceMode);
  if (!['dev','int'].includes(environment) || !isInternalUuid(securityEpoch)
    || typeof repository?.replace!=='function' || typeof passkeyService?.verifiedOperationPrincipal!=='function'
    || typeof authorizationPolicy?.authorize!=='function') throw new TypeError('SYNTHETIC_GENERATION_SERVICE_CONFIGURATION_INVALID');
  const scope=Object.freeze({ environment,securityEpoch: securityEpoch.toLowerCase() });
  return Object.freeze({
    operationHash(intent) { return syntheticGenerationOperationHash(scope,intent); },
    async replace(input) {
      if (!input || Object.keys(input).sort().join(',')!=='correlationId,intent,proofContext') {
        throw new TypeError('SYNTHETIC_GENERATION_SERVICE_INPUT_INVALID');
      }
      const { proofContext,intent: value,correlationId }=input;
      const intent=normalizeSyntheticGenerationIntent(value);
      if (!isInternalUuid(correlationId)) throw new TypeError('SYNTHETIC_GENERATION_CORRELATION_INVALID');
      const hash=syntheticGenerationOperationHash(scope,intent);
      const principal=normalizePlatformPrincipal(passkeyService.verifiedOperationPrincipal(proofContext,hash));
      if (principal.operatorId!==intent.operatorId || principal.providerIdentity.provider!==PLATFORM_ENTRA_PROVIDER
        || principal.assurance.level!=='step_up' || principal.assurance.authenticationContext!==assurance.freshContext
        || await authorizationPolicy.authorize(principal,PLATFORM_PERMISSION.LIFECYCLE_MANAGE)!==true) {
        throw new PlatformAuthorizationError();
      }
      return repository.replace({ principal,intent,correlationId: correlationId.toLowerCase() });
    },
  });
}
