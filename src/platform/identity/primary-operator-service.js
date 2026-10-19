import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformIdentityError } from './errors.js';

// Resolves an already verified Microsoft identity to a provisioned operator.
// This pending context deliberately has neither business roles nor assurance.
export function createPlatformPrimaryOperatorService({ primaryClient, operatorRepository, auditService } = {}) {
  if (typeof primaryClient?.verifyPrimary !== 'function') throw new TypeError('PLATFORM_PRIMARY_VERIFIER_REQUIRED');
  if (typeof operatorRepository?.findActiveByProviderIdentity !== 'function') {
    throw new TypeError('PLATFORM_OPERATOR_REPOSITORY_REQUIRED');
  }
  if (typeof auditService?.createUnmappedAuthenticationFailure !== 'function'
    || typeof auditService?.record !== 'function') throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');
  return Object.freeze({
    async resolve(assertion, { correlationId } = {}) {
      try {
        const identity = await primaryClient.verifyPrimary(assertion);
        const providerIdentity = Object.freeze({ provider: identity.provider,
          tenantReference: identity.tenantReference, subjectReference: identity.subjectReference });
        const operator = await operatorRepository.findActiveByProviderIdentity(providerIdentity);
        if (!operator || operator.status !== 'active' || !isInternalUuid(operator.id)
          || !Number.isSafeInteger(operator.securityVersion) || operator.securityVersion < 1
          || Object.keys(providerIdentity).some(key => operator.providerIdentity?.[key] !== providerIdentity[key])) {
          throw new PlatformIdentityError('PLATFORM_OPERATOR_NOT_PROVISIONED');
        }
        return Object.freeze({ operatorId: operator.id, securityVersion: operator.securityVersion,
          providerIdentity, primaryAuthenticatedAt: identity.authenticatedAt });
      } catch (error) {
        await auditService.record(auditService.createUnmappedAuthenticationFailure({ correlationId,
          reasonCode: error?.code === 'PLATFORM_OPERATOR_NOT_PROVISIONED' ? 'operator_not_provisioned' : 'assertion_rejected' }));
        throw error;
      }
    },
  });
}
