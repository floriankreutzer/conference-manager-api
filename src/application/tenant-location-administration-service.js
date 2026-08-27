import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeTenantLocations } from '../domain/tenant-locations.js';
import {
  assertTenantSettingsRevision,
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';
import { TenantSettingsConflictError } from './tenant-settings-errors.js';

function requireRuntime(repository, authorizationPolicy, auditService) {
  if (!repository
    || typeof repository.current !== 'function'
    || typeof repository.update !== 'function'
    || typeof repository.history !== 'function'
    || typeof repository.revision !== 'function'
    || typeof repository.rollback !== 'function') {
    throw new TypeError('TENANT_LOCATION_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || typeof auditService.createEvent !== 'function') throw new TypeError('AUDIT_SERVICE_REQUIRED');
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function changedAt(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_LOCATION_CLOCK_INVALID');
  return new Date(value);
}

function authorize(policy, principal, tenantContext) {
  policy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
}

function auditEvent(auditService, {
  principal,
  tenantContext,
  correlationId,
  at,
  previousRevision,
  nextRevision,
  operation,
  sourceRevision = null,
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_locations',
    targetId: 'locations',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      operation,
      domain: 'locations',
      ...(sourceRevision === null ? {} : { sourceRevision }),
    },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
    occurredAt: at.toISOString(),
  });
}

function response(result) {
  return Object.freeze({
    schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
    revision: result.revision,
    configuration: result.configuration,
    providerContext: result.providerContext,
  });
}

export function createTenantLocationAdministrationService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  requireRuntime(repository, authorizationPolicy, auditService);
  if (typeof clock !== 'function') throw new TypeError('TENANT_LOCATION_CLOCK_REQUIRED');

  return Object.freeze({
    async getCurrent({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return response(await repository.current(tenantContext.tenantId));
    },

    async update({ principal, tenantContext, correlationId, schemaVersion, expectedRevision, configuration }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const current = await repository.current(tenantContext.tenantId);
      assertTenantSettingsRevision(expected, current.revision);
      const normalized = normalizeTenantLocations(configuration, current.configuration);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await repository.update({
        tenantId: tenantContext.tenantId,
        expectedRevision: expected,
        nextRevision,
        configuration: normalized,
        changedAt: at,
        actorUserId: principal.userId,
        auditEvent: auditEvent(auditService, {
          principal,
          tenantContext,
          correlationId,
          at,
          previousRevision: expected,
          nextRevision,
          operation: 'tenant_locations_update',
        }),
      });
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      return response(result);
    },

    async listHistory({ principal, tenantContext, correlationId, limit = 50 }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_LOCATION_HISTORY_LIMIT_INVALID');
      }
      return repository.history(tenantContext.tenantId, limit);
    },

    async getRevision({ principal, tenantContext, correlationId, revision }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return repository.revision(tenantContext.tenantId, requireTenantSettingsRevision(revision));
    },

    async rollback({ principal, tenantContext, correlationId, schemaVersion, expectedRevision, sourceRevision }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const source = requireTenantSettingsRevision(sourceRevision);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await repository.rollback({
        tenantId: tenantContext.tenantId,
        expectedRevision: expected,
        nextRevision,
        sourceRevision: source,
        changedAt: at,
        actorUserId: principal.userId,
        auditEvent: auditEvent(auditService, {
          principal,
          tenantContext,
          correlationId,
          at,
          previousRevision: expected,
          nextRevision,
          operation: 'tenant_locations_rollback',
          sourceRevision: source,
        }),
      });
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      return response(result);
    },
  });
}
