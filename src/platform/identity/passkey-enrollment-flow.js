import { randomUUID } from 'node:crypto';
import { createPlatformPasskeyEnrollmentService } from './passkey-enrollment-service.js';
import { PlatformIdentityError } from './errors.js';

function reject() { throw new PlatformIdentityError('PLATFORM_PASSKEY_ENROLLMENT_REJECTED'); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject();
}

// Converts only a durably consumed Microsoft pending proof or a freshly verified
// existing key into one-use, instance-private enrollment authority. Browser data
// can never manufacture the internal assertion or supply its identity binding.
export function createPlatformPasskeyEnrollmentFlow({ authService, lifecycleService, repository, verifier,
  environment, securityEpoch } = {}) {
  if (!['consumeEnrollmentPrimary','executeSetupLogin'].every(name => typeof authService?.[name] === 'function')
    || typeof repository?.issueAdditional !== 'function') throw new TypeError('PLATFORM_PASSKEY_ENROLLMENT_FLOW_PORTS_REQUIRED');
  const proofs = new WeakMap();
  const primaryOperatorService = { async resolve(assertion) {
    const value = proofs.get(assertion);
    if (!value) reject();
    proofs.delete(assertion);
    return value;
  } };
  const enrollment = createPlatformPasskeyEnrollmentService({ repository, primaryOperatorService, verifier, environment, securityEpoch });
  async function start(binding, grant, correlationId) {
    const assertion = Object.freeze({}); proofs.set(assertion, binding);
    try { return await enrollment.start({ assertion, grant, correlationId }); }
    finally { proofs.delete(assertion); }
  }
  return Object.freeze({
    async start(value) {
      exact(value, ['cookie','state','grant']); exact(value.grant, ['grantId','token']);
      return authService.consumeEnrollmentPrimary({ cookie: value.cookie, state: value.state },
        binding => start(binding, value.grant, randomUUID()));
    },
    async continueSetup(value) {
      exact(value, ['cookie','state','response']);
      return authService.executeSetupLogin(value, async ({ principal, correlationId }) => {
        const issued = await repository.issueAdditional({ principal, environment, securityEpoch, correlationId });
        if (!issued) reject();
        return start({ operatorId: principal.operatorId, securityVersion: principal.securityVersion,
          providerIdentity: principal.providerIdentity }, issued.grant, correlationId);
      });
    },
    async beginAddition(value) {
      exact(value, ['cookie','state','response','request']);
      if (typeof lifecycleService?.beginAddition !== 'function') reject();
      return lifecycleService.beginAddition(value, ({ principal, grant, correlationId }) => start({
        operatorId: principal.operatorId, securityVersion: principal.securityVersion, providerIdentity: principal.providerIdentity,
      }, grant, correlationId));
    },
    async pending(cookie) { return enrollment.pending(cookie); },
    async register(value) { return enrollment.register(value); },
    async complete(value) { return enrollment.complete(value); },
  });
}
