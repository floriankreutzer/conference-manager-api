import { permissionsForPlatformRoles } from './policy.js';
import { normalizeTrustedPlatformIdentity } from './principal.js';
import { PlatformIdentityError } from './errors.js';

const FAILURE_REASON = Object.freeze({
  PLATFORM_PROVIDER_MISMATCH: 'provider_mismatch',
  PLATFORM_ISSUER_MISMATCH: 'issuer_mismatch',
  PLATFORM_AUDIENCE_MISMATCH: 'audience_mismatch',
  PLATFORM_OPERATOR_TENANT_MISMATCH: 'operator_tenant_mismatch',
  PLATFORM_AUTHORITY_CLAIMS_FORBIDDEN: 'authority_claims_forbidden',
  PLATFORM_CLAIMS_FIELDS_INVALID: 'claims_fields_invalid',
  PLATFORM_ASSURANCE_CONTEXT_REJECTED: 'assurance_rejected',
  PLATFORM_OPERATOR_NOT_PROVISIONED: 'operator_not_provisioned',
});

export function createPlatformIdentityService({
  claimVerifier,
  claimPolicy,
  operatorRepository,
  auditService,
} = {}) {
  if (!claimVerifier || typeof claimVerifier.verify !== 'function') {
    throw new TypeError('PLATFORM_CLAIM_VERIFIER_REQUIRED');
  }
  if (!claimPolicy || typeof claimPolicy.normalize !== 'function') {
    throw new TypeError('PLATFORM_CLAIM_POLICY_REQUIRED');
  }
  if (!operatorRepository || typeof operatorRepository.findActiveByProviderIdentity !== 'function') {
    throw new TypeError('PLATFORM_OPERATOR_REPOSITORY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createUnmappedAuthenticationFailure !== 'function'
    || typeof auditService.record !== 'function'
  ) throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');

  return Object.freeze({
    async verify(assertion, { correlationId } = {}) {
      try {
        const verified = await claimVerifier.verify(assertion);
        const claims = claimPolicy.normalize(verified);
        const operator = await operatorRepository.findActiveByProviderIdentity({
          provider: claims.provider,
          tenantReference: claims.tenantReference,
          subjectReference: claims.subjectReference,
        });
        if (!operator) throw new PlatformIdentityError('PLATFORM_OPERATOR_NOT_PROVISIONED');
        return normalizeTrustedPlatformIdentity({
          operatorId: operator.id,
          providerIdentity: {
            provider: claims.provider,
            tenantReference: claims.tenantReference,
            subjectReference: claims.subjectReference,
          },
          roles: operator.roles,
          permissions: permissionsForPlatformRoles(operator.roles),
          securityVersion: operator.securityVersion,
          targetScope: {
            mode: operator.scopeMode,
            securityVersion: operator.securityVersion,
          },
          assurance: claims.assurance,
        });
      } catch (error) {
        const reasonCode = FAILURE_REASON[error?.code] || 'assertion_rejected';
        await auditService.record(auditService.createUnmappedAuthenticationFailure({
          correlationId,
          reasonCode,
        }));
        throw error;
      }
    },
  });
}
