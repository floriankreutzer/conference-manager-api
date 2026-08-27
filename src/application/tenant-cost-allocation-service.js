import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationInputError } from '../authorization/errors.js';
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

const SAFE_REPOSITORY_INPUT_CODES = new Set([
  'TENANT_COST_CENTER_ARCHIVE_REQUIRED',
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
  if (!auditService || typeof auditService.createEvent !== 'function') {
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

function authorize(policy, principal, tenantContext) {
  policy.requireTenantPermission(
    principal,
    tenantContext,
    PERMISSION.TENANT_CONFIGURE,
  );
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
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  requireRuntime(repository, authorizationPolicy, auditService);
  if (typeof clock !== 'function') throw new TypeError('TENANT_COST_ALLOCATION_CLOCK_REQUIRED');

  return Object.freeze({
    async getCurrent({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
      return response(await repository.current(tenantContext.tenantId));
    },

    async update({
      principal,
      tenantContext,
      correlationId,
      schemaVersion,
      expectedRevision,
      configuration,
    }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
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
      }));
      if (result?.status === 'conflict') {
        throw new TenantSettingsConflictError(result.currentRevision);
      }
      return response(result);
    },

    async listHistory({
      principal,
      tenantContext,
      correlationId,
      limit = 50,
    }) {
      requireCorrelationId(correlationId);
      authorize(authorizationPolicy, principal, tenantContext);
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
      authorize(authorizationPolicy, principal, tenantContext);
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
}
