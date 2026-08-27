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
  TenantCostAllocationInputError,
  createTenantCostAllocationSnapshot,
  normalizeTenantCostAllocation,
} from '../domain/tenant-cost-allocation.js';
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
  'TENANT_COST_CENTER_ARCHIVE_REQUIRED',
  'TENANT_BULK_RECEIPT_INVALID',
  'TENANT_BULK_RECEIPT_EXPIRED',
]);

function requireRuntime(repository, authorizationPolicy, auditService) {
  if (
    !repository
    || typeof repository.current !== 'function'
    || typeof repository.update !== 'function'
    || typeof repository.history !== 'function'
    || typeof repository.revision !== 'function'
  ) {
    throw new TypeError('TENANT_COST_ALLOCATION_REPOSITORY_REQUIRED');
  }
  if (
    !authorizationPolicy
    || typeof authorizationPolicy.requireTenantPermission !== 'function'
  ) {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new AuthorizationInputError('CORRELATION_ID_INVALID');
}

function requireTenantId(value) {
  if (!isInternalUuid(value)) throw new TypeError('TENANT_ID_INVALID');
  return value;
}

function changedAt(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('TENANT_COST_ALLOCATION_CLOCK_INVALID');
  }
  return new Date(value);
}

async function authorize({
  policy,
  auditService,
  principal,
  tenantContext,
  correlationId,
  operation,
}) {
  try {
    policy.requireTenantPermission(
      principal,
      tenantContext,
      PERMISSION.TENANT_CONFIGURE,
    );
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError
      && principal?.tenantId === tenantContext?.tenantId
    ) {
      await auditService.recordAuthorizationDenied({
        principal,
        tenantContext,
        correlationId,
        targetType: 'tenant_cost_allocation',
        targetId: 'cost-allocation',
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
}) {
  return auditService.createEvent({
    principal,
    tenantContext,
    correlationId,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant_cost_allocation',
    targetId: 'cost-allocation',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      operation: 'tenant_cost_allocation_update',
      domain: 'cost_allocation',
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
  });
}

function normalizeInput(configuration) {
  try {
    return normalizeTenantCostAllocation(configuration);
  } catch (error) {
    if (error instanceof TenantCostAllocationInputError) {
      throw new TenantSettingsInputError(error.code);
    }
    throw error;
  }
}

async function safeRepositoryMutation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (SAFE_REPOSITORY_INPUT_CODES.has(error?.code)) {
      throw new TenantSettingsInputError(error.code);
    }
    throw error;
  }
}

export function createTenantCostAllocationService({
  repository,
  bulkTransferRepository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  requireRuntime(repository, authorizationPolicy, auditService);
  if (typeof clock !== 'function') throw new TypeError('TENANT_COST_ALLOCATION_CLOCK_REQUIRED');
  const bulk = bulkTransferRepository ? createTenantBulkTransferOperations({
    aggregate: 'cost_allocation', bulkTransferRepository, clock,
  }) : null;

  let service;
  service = Object.freeze({
    async getCurrent({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({
        policy: authorizationPolicy,
        auditService,
        principal,
        tenantContext,
        correlationId,
        operation: 'read',
      });
      return response(await repository.current(tenantContext.tenantId));
    },

    async update({
      principal,
      tenantContext,
      correlationId,
      schemaVersion,
      expectedRevision,
      configuration,
      bulkReceipt = null,
    }) {
      requireCorrelationId(correlationId);
      await authorize({
        policy: authorizationPolicy,
        auditService,
        principal,
        tenantContext,
        correlationId,
        operation: 'update',
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
        }),
        bulkReceipt,
        bulkResponseFor: response,
      }));
      if (result?.status === 'conflict') {
        throw new TenantSettingsConflictError(result.currentRevision);
      }
      if (result?.status === 'bulk_replay' || result?.status === 'bulk_applied') return result.response;
      return response(result);
    },

    async bulkTemplate({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorize({ policy: authorizationPolicy, auditService, principal, tenantContext, correlationId, operation: 'bulk_template' });
      return bulk.template(type);
    },

    async bulkExport({ principal, tenantContext, correlationId, type }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorize({ policy: authorizationPolicy, auditService, principal, tenantContext, correlationId, operation: 'bulk_export' });
      const current = await repository.current(tenantContext.tenantId);
      return Object.freeze({ revision: current.revision, document: bulk.export(type, current.configuration) });
    },

    async bulkValidate({ principal, tenantContext, correlationId, type, document }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorize({ policy: authorizationPolicy, auditService, principal, tenantContext, correlationId, operation: 'bulk_validate' });
      const current = await repository.current(tenantContext.tenantId);
      return bulk.validate({ principal, tenantContext, correlationId, type, document, current });
    },

    async bulkApply({ principal, tenantContext, correlationId, type, document, receiptId }) {
      if (!bulk) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
      requireCorrelationId(correlationId);
      await authorize({ policy: authorizationPolicy, auditService, principal, tenantContext, correlationId, operation: 'bulk_apply' });
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

    async listHistory({
      principal,
      tenantContext,
      correlationId,
      limit = 50,
    }) {
      requireCorrelationId(correlationId);
      await authorize({
        policy: authorizationPolicy,
        auditService,
        principal,
        tenantContext,
        correlationId,
        operation: 'history',
      });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_COST_ALLOCATION_HISTORY_LIMIT_INVALID');
      }
      return repository.history(tenantContext.tenantId, limit);
    },

    async getRevision({
      principal,
      tenantContext,
      correlationId,
      revision,
    }) {
      requireCorrelationId(correlationId);
      await authorize({
        policy: authorizationPolicy,
        auditService,
        principal,
        tenantContext,
        correlationId,
        operation: 'revision',
      });
      return repository.revision(
        tenantContext.tenantId,
        requireTenantSettingsRevision(revision),
      );
    },

    async snapshotForAuthoritativeRequest({
      tenantId,
      entries,
      totalMinor,
      currency,
    }) {
      const current = await repository.current(requireTenantId(tenantId));
      const snapshot = createTenantCostAllocationSnapshot(
        current.configuration,
        { entries, totalMinor, currency },
      );
      return Object.freeze({
        schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
        configurationRevision: current.revision,
        snapshottedAt: changedAt(clock).toISOString(),
        ...snapshot,
      });
    },
  });
  return service;
}
