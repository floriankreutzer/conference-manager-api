import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuthorizationError } from './errors.js';
import { normalizePlatformPrincipal } from './principal.js';

export function createPlatformTenantTargetPolicy({ operatorRepository } = {}) {
  if (
    !operatorRepository
    || typeof operatorRepository.isTenantAllowed !== 'function'
    || typeof operatorRepository.loadTargetScope !== 'function'
  ) {
    throw new TypeError('PLATFORM_OPERATOR_REPOSITORY_REQUIRED');
  }
  async function queryScope(principalValue, { client } = {}) {
    const principal = normalizePlatformPrincipal(principalValue);
    const scope = await operatorRepository.loadTargetScope({
      operatorId: principal.operatorId,
      securityVersion: principal.securityVersion,
      client,
    });
    if (!scope || scope.mode !== principal.targetScope.mode) {
      throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
    }
    return scope;
  }

  return Object.freeze({
    async authorize(principalValue, tenantId, { client } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      if (!isInternalUuid(tenantId)) throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
      const allowed = await operatorRepository.isTenantAllowed({
        operatorId: principal.operatorId,
        tenantId,
        securityVersion: principal.securityVersion,
        client,
      });
      if (!allowed) throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
      return true;
    },

    queryScope,

    async authorizeCreation(principalValue, { client } = {}) {
      const scope = await queryScope(principalValue, { client });
      if (scope.mode !== 'all') {
        throw new PlatformAuthorizationError('PLATFORM_TENANT_CREATION_DENIED');
      }
      return true;
    },
  });
}
