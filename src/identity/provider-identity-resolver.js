import { isInternalUuid } from '../domain/identifiers.js';

export function createPendingProviderIdentityResolver({ onboardingService, jitUserService } = {}) {
  return Object.freeze({
    async resolve(externalIdentity, { correlationId, onboardingInvitationId = null } = {}) {
      if (!externalIdentity || typeof externalIdentity !== 'object' || Array.isArray(externalIdentity)) {
        throw new TypeError('EXTERNAL_IDENTITY_REQUIRED');
      }
      if (!isInternalUuid(correlationId)) throw new TypeError('IDENTITY_CORRELATION_INVALID');

      if (onboardingInvitationId !== null) {
        if (!isInternalUuid(onboardingInvitationId)) throw new TypeError('ONBOARDING_CONTEXT_INVALID');
        if (!onboardingService || typeof onboardingService.prepareClaim !== 'function') {
          throw new TypeError('TENANT_ONBOARDING_SERVICE_REQUIRED');
        }
        return onboardingService.prepareClaim({
          invitationId: onboardingInvitationId,
          externalIdentity,
          correlationId,
        });
      }

      if (!jitUserService || typeof jitUserService.resolve !== 'function') {
        return Object.freeze({ status: 'onboarding_required' });
      }
      return jitUserService.resolve(externalIdentity, { correlationId });
    },
  });
}
