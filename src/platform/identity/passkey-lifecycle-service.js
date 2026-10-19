import { createHash, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizePlatformPrincipal } from './principal.js';
import { PlatformIdentityError } from './errors.js';

function reject() { throw new PlatformIdentityError('PLATFORM_PASSKEY_LIFECYCLE_REJECTED'); }
function credential(value) {
  if (typeof value !== 'string' || value.length > 1366 || !/^[A-Za-z0-9_-]+$/.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) reject();
  return value;
}
export function createPlatformPasskeyLifecycleService({ authService, sessionService, repository,
  environment, securityEpoch, idFactory = () => randomUUID() } = {}) {
  if (!['startStepUp','executeStepUp','executeCredentialLifecycle'].every(name => typeof authService?.[name] === 'function')
    || typeof sessionService?.resolvePrincipal !== 'function'
    || !['issueAdditional','revokeCredential'].every(name => typeof repository?.[name] === 'function')) {
    throw new TypeError('PLATFORM_PASSKEY_LIFECYCLE_PORTS_REQUIRED');
  }
  if (!['dev', 'int', 'prod'].includes(environment) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_PASSKEY_CONFIGURATION_INVALID');
  }
  function principal(value) {
    const current = normalizePlatformPrincipal(value);
    if (current.session.securityEpoch !== securityEpoch) reject();
    return current;
  }
  function operation(current, action, target = null) {
    return createHash('sha256').update(JSON.stringify(['platform-passkey-lifecycle:v1', environment, securityEpoch,
      current.operatorId, current.securityVersion, action, target])).digest('hex');
  }
  function input(value, revoke) {
    const keys = ['cookie','state','response','request', ...(revoke ? ['credentialId'] : [])];
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== keys.sort().join(',')) reject();
    if (revoke) credential(value.credentialId);
    return value;
  }
  function correlation() { const id = idFactory(); if (!isInternalUuid(id)) reject(); return id; }
  return Object.freeze({
    async startAddition(value) {
      const current = principal(value);
      return authService.startStepUp(current, { operationHash: operation(current, 'add'), correlationId: correlation() });
    },
    async startRevocation(value, credentialId) {
      const current = principal(value);
      return authService.startStepUp(current, { operationHash: operation(current, 'revoke', credential(credentialId)),
        correlationId: correlation() });
    },
    async issueAdditional(value) {
      const request = input(value, false);
      const current = principal(await sessionService.resolvePrincipal(request.request));
      const operationHash = operation(current, 'add'); const correlationId = correlation();
      return authService.executeStepUp({ ...request, operationHash }, async ({ principal: strong, operationHash: actual }) => {
        if (actual !== operationHash || strong.operatorId !== current.operatorId) reject();
        const result = await repository.issueAdditional({ principal: strong, environment, securityEpoch, correlationId });
        if (!result) reject();
        return result;
      });
    },
    async revoke(value) {
      const { credentialId, ...request } = input(value, true);
      const current = principal(await sessionService.resolvePrincipal(request.request));
      const operationHash = operation(current, 'revoke', credentialId); const correlationId = correlation();
      return authService.executeCredentialLifecycle({ ...request, operationHash },
        async ({ principal: strong, operationHash: actual }) => {
          if (actual !== operationHash || strong.operatorId !== current.operatorId) reject();
          const result = await repository.revokeCredential({ principal: strong, environment, securityEpoch, correlationId, credentialId });
          if (!result) reject();
          return result;
        });
    },
  });
}
