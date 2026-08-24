export function createPendingProviderIdentityResolver() {
  return Object.freeze({
    async resolve(externalIdentity) {
      if (!externalIdentity || typeof externalIdentity !== 'object' || Array.isArray(externalIdentity)) {
        throw new TypeError('EXTERNAL_IDENTITY_REQUIRED');
      }
      return Object.freeze({ status: 'onboarding_required' });
    },
  });
}
