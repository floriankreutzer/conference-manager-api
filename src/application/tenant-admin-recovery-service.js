import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { isInternalUuid } from '../domain/identifiers.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const TENANT_ADMIN = 'tenant_admin';

export function createTenantAdminRecoveryService({
  repository,
  auditService,
  authorizeOperator = async () => false,
  clock = () => Date.now(),
} = {}) {
  if (
    !repository
    || typeof repository.listByTenantId !== 'function'
    || typeof repository.setElevatedRoles !== 'function'
  ) {
    throw new TypeError('TENANT_USER_ADMIN_REPOSITORY_REQUIRED');
  }
  if (!auditService || typeof auditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof authorizeOperator !== 'function') throw new TypeError('OPERATOR_AUTHORIZATION_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('RECOVERY_CLOCK_REQUIRED');

  async function usersForTenant(tenantId) {
    const users = [];
    let afterUserId = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await repository.listByTenantId({ tenantId, limit: PAGE_SIZE, afterUserId });
      users.push(...batch);
      if (batch.length < PAGE_SIZE) return users;
      afterUserId = batch.at(-1)?.userId;
      if (!isInternalUuid(afterUserId)) throw new TypeError('RECOVERY_CURSOR_INVALID');
    }
    throw new TypeError('RECOVERY_TENANT_TOO_LARGE');
  }

  return Object.freeze({
    async recoverTenantAdmin({ operatorContext, tenantId, targetUserId, correlationId }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(targetUserId) || !isInternalUuid(correlationId)) {
        throw new TypeError('RECOVERY_INPUT_INVALID');
      }
      if (await authorizeOperator(operatorContext, { tenantId, targetUserId }) !== true) {
        throw new TypeError('OPERATOR_NOT_AUTHORIZED');
      }
      const users = await usersForTenant(tenantId);
      const target = users.find((user) => user.userId === targetUserId);
      if (!target || target.active !== true) throw new TypeError('RECOVERY_TARGET_INVALID');
      const viableAdmin = users.some((user) => (
        user.active === true
        && user.elevatedRoles.includes(TENANT_ADMIN)
      ));
      if (viableAdmin) throw new TypeError('RECOVERY_NOT_REQUIRED');
      const nextRoles = [...new Set([...target.elevatedRoles, TENANT_ADMIN])];
      const changedAtMs = clock();
      if (!Number.isSafeInteger(changedAtMs) || changedAtMs < 0) throw new TypeError('RECOVERY_CLOCK_INVALID');
      const changedAt = new Date(changedAtMs);
      const result = await repository.setElevatedRoles({
        tenantId,
        targetUserId,
        elevatedRoles: nextRoles,
        changedAt,
        auditEventFor({ previousElevatedRoles, nextElevatedRoles }) {
          return auditService.createActorEvent({
            tenantId,
            actorUserId: null,
            correlationId,
            action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
            targetType: 'tenant_user',
            targetId: targetUserId,
            previousState: { elevatedRoles: previousElevatedRoles.join(',') },
            newState: { elevatedRoles: nextElevatedRoles.join(',') },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { actorType: 'platform_operator', operation: 'tenant_admin_recovery' },
            retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
            occurredAt: changedAt.toISOString(),
          });
        },
      });
      if (result.status !== 'updated' && result.status !== 'unchanged') {
        throw new TypeError('RECOVERY_FAILED');
      }
      return result.user;
    },
  });
}
