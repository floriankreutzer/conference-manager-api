import { isInternalUuid } from '../domain/identifiers.js';

export function createPendingProviderIdentityResolver({ onboardingService } = {}) {
  return Object.freeze({
    async resolve(externalIdentity, { correlationId, onboardingInvitationId = null } = {}) {
      if (!externalIdentity || typeof externalIdentity !== 'object' || Array.isArray(externalIdentity)) {
        throw new TypeError('EXTERNAL_IDENTITY_REQUIRED');
      }
      if (onboardingInvitationId === null) {
        return Object.freeze({ status: 'onboarding_required' });
      }
      if (!isInternalUuid(onboardingInvitationId) || !isInternalUuid(correlationId)) {
        throw new TypeError('ONBOARDING_CONTEXT_INVALID');
      }
      if (!onboardingService || typeof onboardingService.prepareClaim !== 'function') {
        throw new TypeError('TENANT_ONBOARDING_SERVICE_REQUIRED');
      }
      return onboardingService.prepareClaim({
        invitationId: onboardingInvitationId,
        externalIdentity,
        correlationId,
      });
    },
  });
}
