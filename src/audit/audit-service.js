import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  normalizeAuditEvent,
} from './event.js';
import { AuditInputError, AuditIntegrityError } from './errors.js';
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

  function createEvent({
    principal,
    tenantContext,
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
    if (!principal || principal.tenantId !== tenantContext?.tenantId) {
      throw new AuditInputError('AUDIT_PRINCIPAL_CONTEXT_INVALID');
    }
    const timestamp = occurredAt || new Date(clock()).toISOString();
    return normalizeAuditEvent({
      tenantId: tenantContext.tenantId,
      actorUserId: principal.userId,
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

  async function record(values) {
    const event = createEvent(values);
    const stored = await repository.append(event);
    if (!stored) throw new AuditIntegrityError('AUDIT_APPEND_FAILED');
    return stored;
  }

  return Object.freeze({
    createEvent,
    record,

    async listTenantEvents({ principal, tenantContext, limit, beforeId, correlationId }) {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_AUDIT_READ,
      );
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
