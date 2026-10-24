import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
} from '../authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  tenantAuthorizationSnapshot,
} from '../authorization/policy.js';
import { normalizeTenantElevatedRoles,resolveTenantRoleSources } from '../authorization/tenant-role-sources.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { TenantUserRoleConflictError } from './tenant-user-errors.js';

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function assertCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('TENANT_USER_CORRELATION_INVALID');
}

function assertTargetUserId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('TENANT_USER_ID_INVALID');
}

function publicUser(user) {
  const snapshot = tenantAuthorizationSnapshot([
    TENANT_ROLE.EMPLOYEE,
    ...resolveTenantRoleSources({ directRoles: user.elevatedRoles,
      microsoftGroupRoles: user.microsoftGroupRoles ?? [] }).effectiveRoles,
  ]);
  return Object.freeze({
    id: user.userId,
    displayName: user.displayName,
    active: user.active,
    roles: snapshot.roles,
  });
}

function roleState(elevatedRoles) {
  return Object.freeze({
    conferenceManager: elevatedRoles.includes(TENANT_ROLE.CONFERENCE_MANAGER),
    tenantAdmin: elevatedRoles.includes(TENANT_ROLE.TENANT_ADMIN),
  });
}

export function createTenantUserAdministrationService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.listByTenantId !== 'function'
    || typeof repository.setElevatedRoles !== 'function'
  ) {
    throw new TypeError('TENANT_USER_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.record !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  async function authorize({ principal, tenantContext, correlationId, targetId, operation }) {
    try {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_USERS_MANAGE,
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: targetId ? 'user' : 'endpoint',
          targetId: targetId || 'tenant_users',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  async function recordConflict({ principal, tenantContext, correlationId, targetUserId, reasonCode }) {
    await auditService.record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
      targetType: 'user',
      targetId: targetUserId,
      previousState: null,
      newState: null,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: { operation: 'set_roles', reasonCode },
      retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    });
  }

  return Object.freeze({
    async listUsers({
      principal,
      tenantContext,
      correlationId,
      limit = 100,
      afterUserId = null,
    }) {
      assertCorrelationId(correlationId);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_USER_LIMIT_INVALID');
      }
      if (afterUserId !== null) assertTargetUserId(afterUserId);
      await authorize({
        principal,
        tenantContext,
        correlationId,
        operation: 'list',
      });
      const users = await repository.listByTenantId({
        tenantId: tenantContext.tenantId,
        limit,
        afterUserId,
      });
      return Object.freeze(users.map(publicUser));
    },

    async setRoles({
      principal,
      tenantContext,
      targetUserId,
      roles,
      correlationId,
    }) {
      assertCorrelationId(correlationId);
      assertTargetUserId(targetUserId);
      const elevatedRoles = normalizeTenantElevatedRoles(roles);
      await authorize({
        principal,
        tenantContext,
        correlationId,
        targetId: targetUserId,
        operation: 'set_roles',
      });
      if (targetUserId === principal.userId) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'user',
          targetId: targetUserId,
          metadata: { operation: 'self_role_change' },
        });
        throw new AuthorizationDeniedError('SELF_ROLE_CHANGE_NOT_AUTHORIZED');
      }

      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) {
        throw new TypeError('TENANT_USER_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const result = await repository.setElevatedRoles({
        tenantId: tenantContext.tenantId,
        targetUserId,
        elevatedRoles,
        changedAt,
        auditEventFor({ previousElevatedRoles, nextElevatedRoles }) {
          return auditService.createEvent({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
            targetType: 'user',
            targetId: targetUserId,
            previousState: roleState(previousElevatedRoles),
            newState: roleState(nextElevatedRoles),
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { operation: 'set_roles' },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: changedAt.toISOString(),
          });
        },
      });

      if (result?.status === 'not_found') {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'user',
          targetId: targetUserId,
          metadata: { operation: 'set_roles' },
        });
        throw concealedNotFound();
      }
      if (result?.status === 'last_tenant_admin') {
        await recordConflict({
          principal,
          tenantContext,
          correlationId,
          targetUserId,
          reasonCode: 'last_tenant_admin',
        });
        throw new TenantUserRoleConflictError('LAST_TENANT_ADMIN_REQUIRED');
      }
      if (result?.status === 'user_inactive') {
        await recordConflict({
          principal,
          tenantContext,
          correlationId,
          targetUserId,
          reasonCode: 'user_inactive',
        });
        throw new TenantUserRoleConflictError('TENANT_USER_INACTIVE');
      }
      if ((result?.status !== 'updated' && result?.status !== 'unchanged') || !result.user) {
        throw new TypeError('TENANT_USER_ROLE_RESULT_INVALID');
      }
      return publicUser(result.user);
    },
  });
}
