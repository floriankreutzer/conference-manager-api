import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION } from '../audit/event.js';
import { PlatformAuthorizationError } from './errors.js';
import { normalizePlatformPrincipal } from './principal.js';

const OPERATION_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export function createPlatformOperationAuthorizer({
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
} = {}) {
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!tenantTargetPolicy || typeof tenantTargetPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.recordDenied !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');
  }

  return Object.freeze({
    async authorize({
      principal: principalValue,
      permission,
      targetTenantId = null,
      operation,
      correlationId,
    } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      if (!OPERATION_PATTERN.test(operation || '')) {
        throw new TypeError('PLATFORM_OPERATION_INVALID');
      }
      if (!isInternalUuid(correlationId)) throw new TypeError('PLATFORM_CORRELATION_ID_INVALID');
      if (targetTenantId !== null && !isInternalUuid(targetTenantId)) {
        throw new TypeError('PLATFORM_TENANT_ID_INVALID');
      }
      let reasonCode = 'permission_denied';
      try {
        if (await authorizationPolicy.authorize(principal, permission) !== true) {
          throw new PlatformAuthorizationError();
        }
        if (targetTenantId !== null) {
          reasonCode = 'target_denied';
          if (await tenantTargetPolicy.authorize(principal, targetTenantId) !== true) {
            throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
          }
        }
        return principal;
      } catch (error) {
        if (!(error instanceof PlatformAuthorizationError)) throw error;
        await auditService.recordDenied({
          principal,
          action: PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED,
          targetTenantId,
          targetType: 'platform_operation',
          targetId: operation,
          metadata: { reasonCode },
          correlationId,
        }, targetTenantId === null ? undefined : { expectedTargetTenantId: targetTenantId });
        throw new PlatformAuthorizationError();
      }
    },
  });
}
