import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
} from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  TenantLocationInputError,
  normalizeTenantLocations,
} from '../domain/tenant-locations.js';
import {
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
  TENANT_SETTINGS_SCHEMA_VERSION,
} from './tenant-settings-revision.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from './tenant-settings-errors.js';

const SAFE_REPOSITORY_INPUT_CODES = new Set([
  'TENANT_LOCATION_REFERENCED_REQUEST',
  'TENANT_LOCATION_REFERENCED_PROVIDER',
  'TENANT_LOCATION_REFERENCED_BOOKING_CHANGE',
  'TENANT_LOCATION_SERVICE_REFERENCE_INVALID',
  'TENANT_LOCATION_CATERING_REFERENCE_INVALID',
  'TENANT_LOCATION_REVISION_NOT_FOUND',
  'TENANT_ROOM_PROVIDER_IMPORT_REQUIRED',
  'TENANT_ROOM_ARCHIVE_REQUIRED',
  'TENANT_SITE_ARCHIVE_REQUIRED',
  'TENANT_SITE_TIME_ZONE_INVALID',
]);

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
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) throw new TypeError('AUDIT_SERVICE_REQUIRED');
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function changedAt(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_LOCATION_CLOCK_INVALID');
  return new Date(value);
}

async function authorize(policy, auditService, {
  principal,
  tenantContext,
  correlationId,
  operation,
}) {
  try {
    policy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_CONFIGURE);
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError
      && principal?.tenantId === tenantContext?.tenantId
    ) {
      await auditService.recordAuthorizationDenied({
        principal,
        tenantContext,
        correlationId,
        targetType: 'tenant_locations',
        targetId: 'locations',
        metadata: { operation },
      });
    }
    throw error;
  }
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

async function safeRepositoryMutation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (SAFE_REPOSITORY_INPUT_CODES.has(error?.code)) throw new TenantSettingsInputError(error.code);
    throw error;
  }
}

function normalizeInput(configuration) {
  try {
    return normalizeTenantLocations(configuration);
  } catch (error) {
    if (error instanceof TenantLocationInputError) throw new TenantSettingsInputError(error.code);
    throw error;
  }
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
      await authorize(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'read',
      });
      return response(await repository.current(tenantContext.tenantId));
    },

    async update({ principal, tenantContext, correlationId, schemaVersion, expectedRevision, configuration }) {
      requireCorrelationId(correlationId);
      await authorize(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'update',
      });
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const normalized = normalizeInput(configuration);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await safeRepositoryMutation(() => repository.update({
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
      }));
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      return response(result);
    },

    async listHistory({ principal, tenantContext, correlationId, limit = 50 }) {
      requireCorrelationId(correlationId);
      await authorize(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'history_list',
      });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_LOCATION_HISTORY_LIMIT_INVALID');
      }
      return repository.history(tenantContext.tenantId, limit);
    },

    async getRevision({ principal, tenantContext, correlationId, revision }) {
      requireCorrelationId(correlationId);
      await authorize(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'history_read',
      });
      return repository.revision(tenantContext.tenantId, requireTenantSettingsRevision(revision));
    },

    async rollback({ principal, tenantContext, correlationId, schemaVersion, expectedRevision, sourceRevision }) {
      requireCorrelationId(correlationId);
      await authorize(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'rollback',
      });
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const source = requireTenantSettingsRevision(sourceRevision);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await safeRepositoryMutation(() => repository.rollback({
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
      }));
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      return response(result);
    },
  });
}
