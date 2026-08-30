import { randomUUID } from 'node:crypto';
import { PLATFORM_PERMISSION } from '../identity/policy.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PlatformAuthorizationError } from '../identity/errors.js';
import { createPlatformBreakGlassAuthorizationContext } from '../identity/break-glass.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  PLATFORM_AUDIT_RETENTION,
  normalizePlatformAuditEvent,
} from './event.js';

export function createPlatformAuditService({
  repository,
  authorizationPolicy,
  tenantTargetPolicy,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.append !== 'function'
    || typeof repository.listVerified !== 'function'
  ) throw new TypeError('PLATFORM_AUDIT_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!tenantTargetPolicy || typeof tenantTargetPolicy.queryScope !== 'function') {
    throw new TypeError('PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') throw new TypeError('PLATFORM_AUDIT_FACTORY_INVALID');

  function correlationId(value) {
    return value === undefined ? idFactory() : value;
  }

  function exactIntent(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('PLATFORM_AUDIT_INTENT_INVALID');
    }
    const allowed = new Set([
      'action',
      'correlationId',
      'metadata',
      'newState',
      'previousState',
      'principal',
      'retentionClass',
      'targetId',
      'targetTenantId',
      'targetType',
    ]);
    if (Object.keys(values).some((key) => !allowed.has(key))) {
      throw new TypeError('PLATFORM_AUDIT_AUTHORITY_FIELDS_FORBIDDEN');
    }
    return values;
  }

  function actorEvent(values, outcome) {
    const intent = exactIntent(values);
    const principal = normalizePlatformPrincipal(intent.principal);
    return normalizePlatformAuditEvent({
      targetTenantId: intent.targetTenantId ?? null,
      previousState: intent.previousState ?? null,
      newState: intent.newState ?? null,
      outcome,
      metadata: intent.metadata ?? {},
      retentionClass: intent.retentionClass ?? PLATFORM_AUDIT_RETENTION.SECURITY,
      action: intent.action,
      targetType: intent.targetType,
      targetId: intent.targetId,
      operatorId: principal.operatorId,
      roles: principal.roles,
      permissions: principal.permissions,
      assuranceLevel: principal.assurance.level,
      occurredAt: new Date(clock()).toISOString(),
      correlationId: correlationId(intent.correlationId),
    });
  }

  function project(event) {
    return Object.freeze({
      sequence: event.sequence,
      operatorId: event.operatorId,
      roles: event.roles,
      permissions: event.permissions,
      assuranceLevel: event.assuranceLevel,
      targetTenantId: event.targetTenantId,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      previousState: event.previousState,
      newState: event.newState,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      outcome: event.outcome,
      metadata: event.metadata,
      retentionClass: event.retentionClass,
    });
  }

  async function queryAndRecord({
    principal: principalValue,
    limit,
    beforeSequence,
    correlationId: providedCorrelationId,
    permission,
    action,
  }) {
    const principal = normalizePlatformPrincipal(principalValue);
    if (await authorizationPolicy.authorize(principal, permission) !== true) {
      throw new PlatformAuthorizationError();
    }
    const scope = await tenantTargetPolicy.queryScope(principal);
    const rows = await repository.listVerified({ limit, beforeSequence, scope });
    await repository.append(actorEvent({
      principal,
      action,
      targetType: 'platform_audit',
      targetId: 'events',
      metadata: { resultCount: rows.length },
      correlationId: providedCorrelationId,
    }, PLATFORM_AUDIT_OUTCOME.SUCCESS));
    return Object.freeze(rows.map(project));
  }

  return Object.freeze({
    createEvent(values) {
      return actorEvent(values, PLATFORM_AUDIT_OUTCOME.SUCCESS);
    },

    createDeniedEvent(values) {
      return actorEvent(values, PLATFORM_AUDIT_OUTCOME.DENIED);
    },

    createBreakGlassUsedEvent({ principal: principalValue, authorization: authorizationValue, correlationId: providedCorrelationId } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      const authorization = createPlatformBreakGlassAuthorizationContext(authorizationValue);
      if (
        principal.operatorId !== authorization.operatorId
        || principal.targetScope.securityVersion !== principal.securityVersion
      ) throw new TypeError('PLATFORM_BREAK_GLASS_ACTOR_MISMATCH');
      return normalizePlatformAuditEvent({
        operatorId: principal.operatorId,
        roles: principal.roles,
        permissions: principal.permissions,
        assuranceLevel: 'break_glass',
        targetTenantId: authorization.targetTenantId,
        previousState: null,
        newState: null,
        outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
        metadata: { permission: authorization.permission },
        retentionClass: PLATFORM_AUDIT_RETENTION.RECOVERY,
        occurredAt: new Date(clock()).toISOString(),
        correlationId: correlationId(providedCorrelationId),
        action: PLATFORM_AUDIT_ACTION.BREAK_GLASS_USED,
        targetType: 'platform_break_glass_grant',
        targetId: authorization.grantId,
      });
    },

    createUnmappedAuthenticationFailure(values = {}) {
      if (
        !values
        || typeof values !== 'object'
        || Array.isArray(values)
        || Object.keys(values).some((key) => !['correlationId', 'reasonCode'].includes(key))
      ) throw new TypeError('PLATFORM_AUDIT_AUTHORITY_FIELDS_FORBIDDEN');
      const { correlationId: providedCorrelationId, reasonCode } = values;
      if (typeof reasonCode !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(reasonCode)) {
        throw new TypeError('PLATFORM_AUTHENTICATION_FAILURE_REASON_INVALID');
      }
      return normalizePlatformAuditEvent({
        operatorId: null,
        roles: [],
        permissions: [],
        assuranceLevel: 'unverified',
        targetTenantId: null,
        previousState: null,
        newState: null,
        outcome: PLATFORM_AUDIT_OUTCOME.FAILURE,
        metadata: { reasonCode },
        retentionClass: PLATFORM_AUDIT_RETENTION.SECURITY,
        occurredAt: new Date(clock()).toISOString(),
        correlationId: correlationId(providedCorrelationId),
        action: 'platform.authentication.failed',
        targetType: 'platform_identity',
        targetId: 'unmapped',
      });
    },

    async record(event, options) {
      return repository.append(normalizePlatformAuditEvent(event), options);
    },

    async recordDenied(values, options) {
      return repository.append(actorEvent(values, PLATFORM_AUDIT_OUTCOME.DENIED), options);
    },

    async list({ principal: principalValue, limit, beforeSequence, correlationId: providedCorrelationId } = {}) {
      return queryAndRecord({
        principal: principalValue,
        limit,
        beforeSequence,
        correlationId: providedCorrelationId,
        permission: PLATFORM_PERMISSION.AUDIT_READ,
        action: PLATFORM_AUDIT_ACTION.AUDIT_READ,
      });
    },

    async export({ principal: principalValue, limit = 100, beforeSequence = null, correlationId: providedCorrelationId } = {}) {
      return queryAndRecord({
        principal: principalValue,
        limit,
        beforeSequence,
        correlationId: providedCorrelationId,
        permission: PLATFORM_PERMISSION.AUDIT_EXPORT,
        action: PLATFORM_AUDIT_ACTION.AUDIT_EXPORTED,
      });
    },
  });
}
