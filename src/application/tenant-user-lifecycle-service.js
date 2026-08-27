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
import { isInternalUuid } from '../domain/identifiers.js';
import { TenantUserLifecycleConflictError } from './tenant-user-lifecycle-errors.js';

const STATUS_FILTER = new Set(['all', 'active', 'disabled']);
const ROLE_FILTER = new Set([
  'all',
  'employee_only',
  TENANT_ROLE.CONFERENCE_MANAGER,
  TENANT_ROLE.TENANT_ADMIN,
]);
const PROVIDER_LINK_FILTER = new Set(['all', 'linked', 'unlinked']);
const MAX_SEARCH_LENGTH = 80;

function concealedNotFound() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) {
    throw new AuthorizationInputError('TENANT_USER_CORRELATION_INVALID');
  }
}

function requireTargetUserId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('TENANT_USER_ID_INVALID');
}

function normalizeSearch(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_SEARCH_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorizationInputError('TENANT_USER_SEARCH_INVALID');
  }
  return value;
}

function normalizeFilter(value, allowed, code, fallback = 'all') {
  const normalized = value ?? fallback;
  if (!allowed.has(normalized)) throw new AuthorizationInputError(code);
  return normalized;
}

function normalizePage({
  limit = 50,
  afterUserId = null,
  search = null,
  status = 'all',
  role = 'all',
  providerLink = 'all',
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AuthorizationInputError('TENANT_USER_LIMIT_INVALID');
  }
  if (afterUserId !== null) requireTargetUserId(afterUserId);
  return Object.freeze({
    limit,
    afterUserId,
    search: normalizeSearch(search),
    status: normalizeFilter(status, STATUS_FILTER, 'TENANT_USER_STATUS_FILTER_INVALID'),
    role: normalizeFilter(role, ROLE_FILTER, 'TENANT_USER_ROLE_FILTER_INVALID'),
    providerLink: normalizeFilter(
      providerLink,
      PROVIDER_LINK_FILTER,
      'TENANT_USER_PROVIDER_FILTER_INVALID',
    ),
  });
}

function isUtcInstant(value) {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function publicUser(user, expectedTenantId) {
  if (
    !user
    || user.tenantId !== expectedTenantId
    || !isInternalUuid(user.userId)
    || typeof user.displayName !== 'string'
    || user.displayName.length < 1
    || user.displayName.length > 160
    || typeof user.active !== 'boolean'
    || !Number.isSafeInteger(user.lifecycleVersion)
    || user.lifecycleVersion < 1
    || !Array.isArray(user.elevatedRoles)
    || typeof user.identityLinked !== 'boolean'
    || (user.identityLinkedAt !== null && !isUtcInstant(user.identityLinkedAt))
    || (user.lastSignInAt !== null && !isUtcInstant(user.lastSignInAt))
    || !Number.isSafeInteger(user.ownedOpenRequestCount)
    || user.ownedOpenRequestCount < 0
  ) {
    throw new TypeError('TENANT_USER_LIFECYCLE_RESULT_INVALID');
  }
  const snapshot = tenantAuthorizationSnapshot([
    TENANT_ROLE.EMPLOYEE,
    ...user.elevatedRoles,
  ]);
  return Object.freeze({
    id: user.userId,
    displayName: user.displayName,
    active: user.active,
    roles: snapshot.roles,
    lifecycle: Object.freeze({
      status: user.active ? 'active' : 'disabled',
      version: user.lifecycleVersion,
    }),
    identityProvider: Object.freeze({
      linked: user.identityLinked,
      linkedAt: user.identityLinkedAt,
    }),
    lastSignInAt: user.lastSignInAt,
    requestOwnership: Object.freeze({
      openRequestCount: user.ownedOpenRequestCount,
      ownershipPreservedOnDisable: true,
    }),
  });
}

export function createTenantUserLifecycleService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.listByTenantId !== 'function'
    || typeof repository.changeAccess !== 'function'
  ) {
    throw new TypeError('TENANT_USER_LIFECYCLE_REPOSITORY_REQUIRED');
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
          targetId: targetId || 'tenant_user_lifecycle',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  async function recordConflict({
    principal,
    tenantContext,
    correlationId,
    targetUserId,
    operation,
    reasonCode,
  }) {
    await auditService.record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
      targetType: 'user',
      targetId: targetUserId,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: { operation, reasonCode },
      retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    });
  }

  return Object.freeze({
    async listUsers({ principal, tenantContext, correlationId, ...pageValues }) {
      requireCorrelationId(correlationId);
      const page = normalizePage(pageValues);
      await authorize({
        principal,
        tenantContext,
        correlationId,
        operation: 'list_lifecycle',
      });
      const users = await repository.listByTenantId({
        tenantId: tenantContext.tenantId,
        ...page,
        limit: page.limit + 1,
      });
      if (!Array.isArray(users)) throw new TypeError('TENANT_USER_LIFECYCLE_RESULT_INVALID');
      const hasMore = users.length > page.limit;
      const visible = users.slice(0, page.limit).map((user) => publicUser(user, tenantContext.tenantId));
      return Object.freeze({
        users: Object.freeze(visible),
        nextAfterId: hasMore ? visible.at(-1)?.id || null : null,
      });
    },

    async setAccess({
      principal,
      tenantContext,
      targetUserId,
      active,
      expectedVersion,
      correlationId,
    }) {
      requireCorrelationId(correlationId);
      requireTargetUserId(targetUserId);
      if (typeof active !== 'boolean' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new AuthorizationInputError('TENANT_USER_LIFECYCLE_INPUT_INVALID');
      }
      const operation = active ? 'reactivate' : 'disable';
      await authorize({
        principal,
        tenantContext,
        correlationId,
        targetId: targetUserId,
        operation,
      });
      if (targetUserId === principal.userId) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'user',
          targetId: targetUserId,
          metadata: { operation: `self_${operation}` },
        });
        throw new AuthorizationDeniedError('SELF_LIFECYCLE_CHANGE_NOT_AUTHORIZED');
      }

      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0) {
        throw new TypeError('TENANT_USER_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const result = await repository.changeAccess({
        tenantId: tenantContext.tenantId,
        targetUserId,
        active,
        expectedVersion,
        changedAt,
        auditEventFor({
          previousActive,
          nextActive,
          previousVersion,
          nextVersion,
          openRequestCount,
          revokedSessionCount,
        }) {
          return auditService.createEvent({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
            targetType: 'user',
            targetId: targetUserId,
            previousState: {
              active: previousActive,
              lifecycleVersion: previousVersion,
            },
            newState: {
              active: nextActive,
              lifecycleVersion: nextVersion,
            },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: {
              openRequestCount,
              operation,
              revokedSessionCount,
            },
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
          metadata: { operation },
        });
        throw concealedNotFound();
      }
      if (result?.status === 'last_tenant_admin') {
        await recordConflict({
          principal,
          tenantContext,
          correlationId,
          targetUserId,
          operation,
          reasonCode: 'last_tenant_admin',
        });
        throw new TenantUserLifecycleConflictError('LAST_TENANT_ADMIN_REQUIRED', {
          currentVersion: result.currentVersion,
        });
      }
      if (result?.status === 'version_conflict') {
        await recordConflict({
          principal,
          tenantContext,
          correlationId,
          targetUserId,
          operation,
          reasonCode: 'version_conflict',
        });
        throw new TenantUserLifecycleConflictError('TENANT_USER_LIFECYCLE_VERSION_CONFLICT', {
          currentVersion: result.currentVersion,
        });
      }
      if ((result?.status !== 'updated' && result?.status !== 'unchanged') || !result.user) {
        throw new TypeError('TENANT_USER_LIFECYCLE_RESULT_INVALID');
      }
      return publicUser(result.user, tenantContext.tenantId);
    },
  });
}
