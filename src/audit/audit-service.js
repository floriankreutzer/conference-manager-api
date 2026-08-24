import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from './event.js';
import { AuditInputError, AuditIntegrityError } from './errors.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';

const MAX_AUDIT_ID = 9_223_372_036_854_775_807n;

function normalizePage({ limit = 50, beforeId = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AuditInputError('AUDIT_LIMIT_INVALID');
  }
  if (beforeId === null) return Object.freeze({ limit, beforeId: null });
  if (typeof beforeId !== 'string' || !/^[1-9]\d{0,18}$/.test(beforeId)) {
    throw new AuditInputError('AUDIT_CURSOR_INVALID');
  }
  if (BigInt(beforeId) > MAX_AUDIT_ID) throw new AuditInputError('AUDIT_CURSOR_INVALID');
  return Object.freeze({ limit, beforeId });
}

export function createAuditService({
  repository,
  authorizationPolicy,
  clock = () => Date.now(),
  correlationFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.append !== 'function'
    || typeof repository.listByTenantId !== 'function'
    || typeof repository.verifyTenantChain !== 'function'
  ) {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function' || typeof correlationFactory !== 'function') {
    throw new TypeError('AUDIT_RUNTIME_DEPENDENCY_INVALID');
  }

  function buildEvent({
    tenantId,
    actorUserId,
    correlationId,
    action,
    targetType,
    targetId,
    previousState = null,
    newState = null,
    outcome,
    metadata = {},
    retentionClass,
    occurredAt,
  }) {
    const clockValue = occurredAt === undefined ? clock() : null;
    if (occurredAt === undefined && (!Number.isSafeInteger(clockValue) || clockValue < 0)) {
      throw new AuditInputError('AUDIT_CLOCK_INVALID');
    }
    const timestamp = occurredAt || new Date(clockValue).toISOString();
    return normalizeAuditEvent({
      tenantId,
      actorUserId,
      action,
      targetType,
      targetId,
      previousState,
      newState,
      occurredAt: timestamp,
      correlationId: correlationId || correlationFactory(),
      outcome,
      metadata,
      retentionClass,
    });
  }

  function createEvent({ principal, tenantContext, ...values }) {
    if (!principal || principal.tenantId !== tenantContext?.tenantId) {
      throw new AuditInputError('AUDIT_PRINCIPAL_CONTEXT_INVALID');
    }
    return buildEvent({
      tenantId: tenantContext.tenantId,
      actorUserId: principal.userId,
      ...values,
    });
  }

  function createActorEvent({ tenantId, actorUserId, ...values }) {
    return buildEvent({ tenantId, actorUserId, ...values });
  }

  async function record(values) {
    const event = createEvent(values);
    const stored = await repository.append(event);
    if (!stored) throw new AuditIntegrityError('AUDIT_APPEND_FAILED');
    return stored;
  }

  async function recordAuthorizationDenied({
    principal,
    tenantContext,
    correlationId,
    targetType,
    targetId,
    metadata = {},
  }) {
    return record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.AUTHORIZATION_DENIED,
      targetType,
      targetId,
      outcome: AUDIT_OUTCOME.DENIED,
      metadata,
      retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
    });
  }

  return Object.freeze({
    createEvent,
    createActorEvent,
    record,
    recordAuthorizationDenied,

    async listTenantEvents({ principal, tenantContext, limit, beforeId, correlationId }) {
      try {
        authorizationPolicy.requireTenantPermission(
          principal,
          tenantContext,
          PERMISSION.TENANT_AUDIT_READ,
        );
      } catch (error) {
        if (error instanceof AuthorizationDeniedError) {
          await recordAuthorizationDenied({
            principal,
            tenantContext,
            correlationId,
            targetType: 'audit',
            targetId: 'tenant-audit',
            metadata: { operation: 'read' },
          });
        }
        throw error;
      }
      if (await repository.verifyTenantChain(tenantContext.tenantId) !== true) {
        throw new AuditIntegrityError();
      }
      const page = normalizePage({ limit, beforeId });
      const events = await repository.listByTenantId(tenantContext.tenantId, page);
      await record({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.AUDIT_READ,
        targetType: 'audit',
        targetId: 'tenant-audit',
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { resultCount: events.length },
        retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      });
      return events;
    },
  });
}
