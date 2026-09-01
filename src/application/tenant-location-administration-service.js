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
import { createTenantBulkTransferOperations } from './tenant-bulk-transfer-operations.js';

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
  'TENANT_BULK_RECEIPT_INVALID',
  'TENANT_BULK_RECEIPT_EXPIRED',
]);
const LOCATION_READ_PERMISSIONS = Object.freeze([
  PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
  PERMISSION.TENANT_CONFIGURE,
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

async function recordAuthorizationDenied(auditService, {
  principal,
  tenantContext,
  correlationId,
  operation,
}) {
  if (principal?.tenantId !== tenantContext?.tenantId) return;
  await auditService.recordAuthorizationDenied({
    principal,
    tenantContext,
    correlationId,
    targetType: 'tenant_locations',
    targetId: 'locations',
    metadata: { operation },
  });
}

async function authorizeAny(policy, auditService, {
  principal,
  tenantContext,
  correlationId,
  operation,
  permissions = LOCATION_READ_PERMISSIONS,
}) {
  let denied = null;
  for (const permission of permissions) {
    try {
      policy.requireTenantPermission(principal, tenantContext, permission);
      return;
    } catch (error) {
      if (!(error instanceof AuthorizationDeniedError)) throw error;
      denied = error;
    }
  }
  await recordAuthorizationDenied(auditService, {
    principal, tenantContext, correlationId, operation,
  });
  throw denied ?? new AuthorizationDeniedError('PERMISSION_REQUIRED');
}

function stableConfiguration(value) {
  const sites = [...value.sites].sort((left, right) => left.id.localeCompare(right.id));
  const rooms = [...value.rooms].sort((left, right) => left.id.localeCompare(right.id));
  return { sites, rooms };
}

function technicalShape(value) {
  const configuration = stableConfiguration(value);
  return JSON.stringify({
    sites: configuration.sites,
    rooms: configuration.rooms.map((room) => ({ id: room.id, siteId: room.siteId })),
  });
}

function businessShape(value) {
  const configuration = stableConfiguration(value);
  return JSON.stringify(configuration.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    capacity: room.capacity,
    active: room.active,
    floor: room.floor,
    equipment: room.equipment,
    accessibility: room.accessibility,
    serviceIds: room.serviceIds,
    cateringPackageIds: room.cateringPackageIds,
    floorplanAssetId: room.floorplanAssetId,
    mediaAssetIds: room.mediaAssetIds,
  })));
}

function requiredMutationPermissions(current, proposed) {
  const required = [];
  if (technicalShape(current) !== technicalShape(proposed)) {
    required.push(PERMISSION.TENANT_CONFIGURE);
  }
  if (businessShape(current) !== businessShape(proposed)) {
    required.push(PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE);
  }
  return required;
}

function assertMutationAuthorized(policy, input, current, proposed) {
  const required = requiredMutationPermissions(current, proposed);
  for (const permission of required) {
    policy.requireTenantPermission(input.principal, input.tenantContext, permission);
  }
  return true;
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

async function authorizedRepositoryMutation(auditService, authorizationInput, operation) {
  try {
    return await safeRepositoryMutation(operation);
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) {
      await recordAuthorizationDenied(auditService, authorizationInput);
    }
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
  bulkTransferRepository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  requireRuntime(repository, authorizationPolicy, auditService);
  if (typeof clock !== 'function') throw new TypeError('TENANT_LOCATION_CLOCK_REQUIRED');
  const bulk = bulkTransferRepository ? createTenantBulkTransferOperations({
    aggregate: 'locations', bulkTransferRepository, clock,
  }) : null;

  let service;
  service = Object.freeze({
    async getCurrent({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'read',
      });
      return response(await repository.current(tenantContext.tenantId));
    },

    async update({
      principal, tenantContext, correlationId, schemaVersion, expectedRevision, configuration,
      bulkReceipt = null,
    }) {
      requireCorrelationId(correlationId);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const normalized = normalizeInput(configuration);
      const authorizationInput = {
        principal, tenantContext, correlationId, operation: 'update',
      };
      await authorizeAny(authorizationPolicy, auditService, authorizationInput);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await authorizedRepositoryMutation(
        auditService,
        authorizationInput,
        () => repository.update({
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
          assertAuthorizedTransition: (current, proposed) => {
            return assertMutationAuthorized(
              authorizationPolicy,
              authorizationInput,
              current,
              proposed,
            );
          },
          bulkReceipt,
          bulkResponseFor: response,
        }),
      );
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status === 'bulk_replay' || result?.status === 'bulk_applied') return result.response;
      return response(result);
    },

    async bulkTemplate({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'bulk_template',
      });
      return bulk.template(type);
    },

    async bulkExport({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'bulk_export',
      });
      const current = await repository.current(tenantContext.tenantId);
      return Object.freeze({ revision: current.revision, document: bulk.export(type, current.configuration) });
    },

    async bulkValidate({ principal, tenantContext, correlationId, type, document }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'bulk_validate',
      });
      const current = await repository.current(tenantContext.tenantId);
      return bulk.validate({ principal, tenantContext, correlationId, type, document, current });
    },

    async bulkApply({ principal, tenantContext, correlationId, type, document, receiptId }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'bulk_apply',
      });
      const current = await repository.current(tenantContext.tenantId);
      return bulk.apply({
        principal, tenantContext, type, document, receiptId, current,
        update: ({ expectedRevision, configuration, bulkReceipt }) => service.update({
          principal, tenantContext, correlationId,
          schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
          expectedRevision, configuration, bulkReceipt,
        }),
      });
    },

    async listHistory({ principal, tenantContext, correlationId, limit = 50 }) {
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'history_list',
      });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_LOCATION_HISTORY_LIMIT_INVALID');
      }
      return repository.history(tenantContext.tenantId, limit);
    },

    async getRevision({ principal, tenantContext, correlationId, revision }) {
      requireCorrelationId(correlationId);
      await authorizeAny(authorizationPolicy, auditService, {
        principal, tenantContext, correlationId, operation: 'history_read',
      });
      return repository.revision(tenantContext.tenantId, requireTenantSettingsRevision(revision));
    },

    async rollback({ principal, tenantContext, correlationId, schemaVersion, expectedRevision, sourceRevision }) {
      requireCorrelationId(correlationId);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const source = requireTenantSettingsRevision(sourceRevision);
      const authorizationInput = {
        principal, tenantContext, correlationId, operation: 'rollback',
      };
      await authorizeAny(authorizationPolicy, auditService, authorizationInput);
      const nextRevision = nextTenantSettingsRevision(expected);
      const at = changedAt(clock);
      const result = await authorizedRepositoryMutation(
        auditService,
        authorizationInput,
        () => repository.rollback({
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
          assertAuthorizedTransition: (current, proposed) => {
            return assertMutationAuthorized(
              authorizationPolicy,
              authorizationInput,
              current,
              proposed,
            );
          },
        }),
      );
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      return response(result);
    },
  });
  return service;
}
