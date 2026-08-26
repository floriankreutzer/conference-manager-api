import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../../audit/event.js';
import { AuthorizationInputError } from '../../authorization/errors.js';
import { PERMISSION } from '../../authorization/policy.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import {
  requireExpectedRevision,
  requireHistoryLimit,
  requireRevision,
  requireTenantConfigurationChangeKind,
  requireTenantConfigurationDomain,
  TENANT_CONFIGURATION_CHANGE_KIND,
} from '../../domain/tenant-configuration/protocol.js';

function requireRuntime({ repository, authorizationPolicy, auditService, normalize }) {
  if (
    !repository
    || typeof repository.current !== 'function'
    || typeof repository.update !== 'function'
    || typeof repository.listHistory !== 'function'
    || typeof repository.revision !== 'function'
    || typeof repository.rollback !== 'function'
  ) {
    throw new TypeError('TENANT_CONFIGURATION_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof normalize !== 'function') throw new TypeError('TENANT_CONFIGURATION_NORMALIZER_REQUIRED');
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function clockDate(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_CONFIGURATION_CLOCK_INVALID');
  return new Date(value);
}

function authorize(authorizationPolicy, principal, tenantContext) {
  authorizationPolicy.requireTenantPermission(
    principal,
    tenantContext,
    PERMISSION.TENANT_CONFIGURE,
  );
}

function auditEvent(auditService, {
  principal,
  tenantContext,
  correlationId,
  domain,
  changedAt,
  previousRevision,
  nextRevision,
  changeKind,
  sourceRevision = null,
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_configuration',
    targetId: domain,
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      operation: 'tenant_configuration_change',
      domain,
      changeKind,
      ...(sourceRevision === null ? {} : { sourceRevision }),
    },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: changedAt.toISOString(),
  });
}

export function createVersionedTenantConfigurationService({
  domain,
  repository,
  normalize,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  const normalizedDomain = requireTenantConfigurationDomain(domain);
  requireRuntime({ repository, authorizationPolicy, auditService, normalize });
  if (typeof clock !== 'function') throw new TypeError('TENANT_CONFIGURATION_CLOCK_REQUIRED');

  return Object.freeze({
    async getCurrent({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return repository.current(tenantContext.tenantId);
    },

    async update({
      principal,
      tenantContext,
      correlationId,
      expectedRevision,
      configuration,
      changeKind = TENANT_CONFIGURATION_CHANGE_KIND.CHANGE,
    }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      const normalizedExpectedRevision = requireExpectedRevision(expectedRevision);
      const normalizedChangeKind = requireTenantConfigurationChangeKind(changeKind);
      if (
        normalizedChangeKind !== TENANT_CONFIGURATION_CHANGE_KIND.CHANGE
        && normalizedChangeKind !== TENANT_CONFIGURATION_CHANGE_KIND.IMPORT
      ) {
        throw new TypeError('TENANT_CONFIGURATION_CHANGE_KIND_INVALID');
      }
      const current = await repository.current(tenantContext.tenantId);
      const normalized = normalize(configuration, current.configuration);
      const changedAt = clockDate(clock);
      const nextRevision = requireRevision(normalizedExpectedRevision + 1);
      return repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision: normalizedExpectedRevision,
        configuration: normalized,
        changeKind: normalizedChangeKind,
        actorUserId: principal.userId,
        changedAt,
        auditEvent: auditEvent(auditService, {
          principal,
          tenantContext,
          correlationId,
          domain: normalizedDomain,
          changedAt,
          previousRevision: normalizedExpectedRevision,
          nextRevision,
          changeKind: normalizedChangeKind,
        }),
      });
    },

    async listHistory({ principal, tenantContext, correlationId, limit = 50 }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return repository.listHistory(
        tenantContext.tenantId,
        requireHistoryLimit(limit),
      );
    },

    async getRevision({ principal, tenantContext, correlationId, revision }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return repository.revision(
        tenantContext.tenantId,
        requireRevision(revision),
      );
    },

    async rollback({
      principal,
      tenantContext,
      correlationId,
      expectedRevision,
      sourceRevision,
    }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      const normalizedExpectedRevision = requireExpectedRevision(expectedRevision);
      const normalizedSourceRevision = requireRevision(sourceRevision);
      const changedAt = clockDate(clock);
      const nextRevision = requireRevision(normalizedExpectedRevision + 1);
      return repository.rollback({
        tenantId: tenantContext.tenantId,
        expectedRevision: normalizedExpectedRevision,
        sourceRevision: normalizedSourceRevision,
        actorUserId: principal.userId,
        changedAt,
        auditEvent: auditEvent(auditService, {
          principal,
          tenantContext,
          correlationId,
          domain: normalizedDomain,
          changedAt,
          previousRevision: normalizedExpectedRevision,
          nextRevision,
          changeKind: TENANT_CONFIGURATION_CHANGE_KIND.ROLLBACK,
          sourceRevision: normalizedSourceRevision,
        }),
      });
    },
  });
}
