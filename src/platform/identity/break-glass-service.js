import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_RETENTION } from '../audit/event.js';
import { PlatformAuthorizationError } from './errors.js';
import { createPlatformBreakGlassGrant } from './break-glass.js';
import { PLATFORM_PERMISSION } from './policy.js';
import { normalizePlatformPrincipal } from './principal.js';

const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('PLATFORM_CORRELATION_ID_INVALID');
  return value;
}

function requireApproval(value) {
  if (!APPROVAL_REFERENCE_PATTERN.test(value || '')) {
    throw new TypeError('PLATFORM_BREAK_GLASS_APPROVAL_INVALID');
  }
  return value;
}

function requireReason(value) {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length < 10
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError('PLATFORM_BREAK_GLASS_REASON_INVALID');
  return value;
}

export function createPlatformBreakGlassService({
  repository,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  tokenFactory,
  idFactory,
} = {}) {
  if (
    !repository
    || typeof repository.issue !== 'function'
    || typeof repository.revoke !== 'function'
    || typeof repository.executeAuthorizedMutation !== 'function'
  ) throw new TypeError('PLATFORM_BREAK_GLASS_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!tenantTargetPolicy || typeof tenantTargetPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.createDeniedEvent !== 'function'
    || typeof auditService.createBreakGlassUsedEvent !== 'function'
  ) throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');

  async function authorizePair(principalValue, approverValue, targetTenantId) {
    const principal = normalizePlatformPrincipal(principalValue);
    const approver = normalizePlatformPrincipal(approverValue);
    if (principal.operatorId === approver.operatorId || !isInternalUuid(targetTenantId)) {
      throw new PlatformAuthorizationError('PLATFORM_BREAK_GLASS_DUAL_CONTROL_REQUIRED');
    }
    for (const candidate of [principal, approver]) {
      if (await authorizationPolicy.authorize(candidate, PLATFORM_PERMISSION.BREAK_GLASS_MANAGE) !== true) {
        throw new PlatformAuthorizationError();
      }
      if (await tenantTargetPolicy.authorize(candidate, targetTenantId) !== true) {
        throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
      }
    }
    return Object.freeze({ principal, approver });
  }

  function administrativeEvent(principal, grant, action, correlationId, approvalReference) {
    return auditService.createEvent({
      principal,
      action,
      targetTenantId: grant.targetTenantId,
      targetType: 'platform_break_glass_grant',
      targetId: grant.id,
      metadata: {
        approvalReference,
        permission: grant.permission,
      },
      retentionClass: PLATFORM_AUDIT_RETENTION.RECOVERY,
      correlationId,
    });
  }

  return Object.freeze({
    async issue({
      principal: principalValue,
      approverPrincipal: approverValue,
      targetTenantId,
      permission,
      reason,
      approvalReference,
      ttlSeconds,
      correlationId,
    } = {}) {
      const { principal, approver } = await authorizePair(
        principalValue,
        approverValue,
        targetTenantId,
      );
      const generated = createPlatformBreakGlassGrant({
        operatorId: principal.operatorId,
        operatorSecurityVersion: principal.securityVersion,
        approverOperatorId: approver.operatorId,
        approverSecurityVersion: approver.securityVersion,
        targetTenantId,
        permission,
        reason,
        approvalReference,
        ttlSeconds,
        ...(tokenFactory ? { tokenFactory } : {}),
        ...(idFactory ? { idFactory } : {}),
      });
      const requestCorrelationId = requireCorrelationId(correlationId);
      const grant = await repository.issue(generated.record, (stored) => administrativeEvent(
        principal,
        stored,
        PLATFORM_AUDIT_ACTION.BREAK_GLASS_GRANTED,
        requestCorrelationId,
        generated.record.approvalReference,
      ));
      if (!grant) throw new PlatformAuthorizationError('PLATFORM_BREAK_GLASS_ISSUE_REJECTED');
      return Object.freeze({ token: generated.token, grant });
    },

    async revoke({
      principal: principalValue,
      approverPrincipal: approverValue,
      grantId,
      targetTenantId,
      reason,
      approvalReference,
      correlationId,
    } = {}) {
      const { principal, approver } = await authorizePair(
        principalValue,
        approverValue,
        targetTenantId,
      );
      if (!isInternalUuid(grantId)) throw new TypeError('PLATFORM_BREAK_GLASS_GRANT_ID_INVALID');
      const requestCorrelationId = requireCorrelationId(correlationId);
      const record = Object.freeze({
        grantId,
        operatorId: principal.operatorId,
        operatorSecurityVersion: principal.securityVersion,
        approverOperatorId: approver.operatorId,
        approverSecurityVersion: approver.securityVersion,
        targetTenantId,
        reason: requireReason(reason),
        approvalReference: requireApproval(approvalReference),
      });
      const grant = await repository.revoke(record, (stored) => administrativeEvent(
        principal,
        stored,
        PLATFORM_AUDIT_ACTION.BREAK_GLASS_REVOKED,
        requestCorrelationId,
        record.approvalReference,
      ));
      if (!grant) throw new PlatformAuthorizationError('PLATFORM_BREAK_GLASS_REVOKE_REJECTED');
      return grant;
    },

    async execute({
      principal: principalValue,
      token,
      targetTenantId,
      permission,
      correlationId,
      mutation,
    } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      if (await authorizationPolicy.authorize(principal, PLATFORM_PERMISSION.BREAK_GLASS_MANAGE) !== true) {
        throw new PlatformAuthorizationError();
      }
      if (await tenantTargetPolicy.authorize(principal, targetTenantId) !== true) {
        throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
      }
      if (typeof mutation !== 'function') throw new TypeError('PLATFORM_BREAK_GLASS_MUTATION_REQUIRED');
      const requestCorrelationId = requireCorrelationId(correlationId);
      const result = await repository.executeAuthorizedMutation({
        consumption: {
          token,
          operatorId: principal.operatorId,
          operatorSecurityVersion: principal.securityVersion,
          targetTenantId,
          permission,
        },
        eventFactory: (grant) => auditService.createBreakGlassUsedEvent({
          principal,
          authorization: grant,
          correlationId: requestCorrelationId,
        }),
        deniedEventFactory: () => auditService.createDeniedEvent({
          principal,
          action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_DENIED,
          targetTenantId,
          targetType: 'platform_break_glass_grant',
          targetId: 'attempt',
          metadata: { reasonCode: 'grant_rejected' },
          retentionClass: PLATFORM_AUDIT_RETENTION.RECOVERY,
          correlationId: requestCorrelationId,
        }),
        mutation,
      });
      if (!result) throw new PlatformAuthorizationError('PLATFORM_BREAK_GLASS_DENIED');
      return result.result;
    },
  });
}
