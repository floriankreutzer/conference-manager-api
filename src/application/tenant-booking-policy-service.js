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
  TenantBookingPolicyInputError,
  evaluateTenantBookingPolicy,
  evaluateTenantBookingPolicySnapshot,
  normalizeTenantBookingPolicies,
} from '../domain/tenant-booking-policies.js';
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
  'TENANT_BOOKING_POLICY_EFFECTIVE_VERSION_IMMUTABLE',
  'TENANT_BOOKING_POLICY_RETROACTIVE_VERSION_FORBIDDEN',
  'TENANT_BOOKING_POLICY_CURRENT_VERSION_REQUIRED',
  'TENANT_BOOKING_POLICY_SITE_REFERENCE_INVALID',
  'TENANT_BOOKING_POLICY_ROOM_REFERENCE_INVALID',
  'TENANT_BOOKING_POLICY_ROOM_SITE_REFERENCE_INVALID',
  'TENANT_BOOKING_POLICY_SERVICE_REFERENCE_INVALID',
]);

function requireRuntime(repository, authorizationPolicy, auditService) {
  if (
    !repository
    || typeof repository.current !== 'function'
    || typeof repository.update !== 'function'
    || typeof repository.history !== 'function'
    || typeof repository.revision !== 'function'
  ) {
    throw new TypeError('TENANT_BOOKING_POLICY_REPOSITORY_REQUIRED');
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
    throw new TypeError('TENANT_BOOKING_POLICY_CLOCK_INVALID');
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
        targetType: 'tenant_booking_policies',
        targetId: 'booking-policies',
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
    targetType: 'tenant_booking_policies',
    targetId: 'booking-policies',
    previousState: { revision: previousRevision },
    newState: { revision: nextRevision },
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: {
      operation: 'tenant_booking_policies_update',
      domain: 'booking_policies',
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
    return normalizeTenantBookingPolicies(configuration);
  } catch (error) {
    if (error instanceof TenantBookingPolicyInputError) {
      throw new TenantSettingsInputError(error.code);
    }
    throw error;
  }
}

function normalizePersistedSnapshot(value) {
  const keys = new Set([
    'schemaVersion',
    'configurationRevision',
    'policyVersionId',
    'effectiveFrom',
    'evaluatedAt',
    'rules',
  ]);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== keys.size
    || Object.keys(value).some((key) => !keys.has(key))
    || value.schemaVersion !== TENANT_SETTINGS_SCHEMA_VERSION
    || !Number.isSafeInteger(value.configurationRevision)
    || value.configurationRevision < 1
    || value.configurationRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('TENANT_BOOKING_POLICY_SNAPSHOT_INVALID');
  }
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    configurationRevision: value.configurationRevision,
    policy: Object.freeze({
      policyVersionId: value.policyVersionId,
      effectiveFrom: value.effectiveFrom,
      evaluatedAt: value.evaluatedAt,
      rules: value.rules,
    }),
  });
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

export function createTenantBookingPolicyService({
  repository,
  authorizationPolicy,
  auditService,
  clock = () => Date.now(),
} = {}) {
  requireRuntime(repository, authorizationPolicy, auditService);
  if (typeof clock !== 'function') throw new TypeError('TENANT_BOOKING_POLICY_CLOCK_REQUIRED');

  return Object.freeze({
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
      await authorize({
        policy: authorizationPolicy,
        auditService,
        principal,
        tenantContext,
        correlationId,
        operation: 'history',
      });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthorizationInputError('TENANT_BOOKING_POLICY_HISTORY_LIMIT_INVALID');
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

    async evaluateCurrentForRequest({
      tenantId,
      operation,
      startsAt,
      siteId,
      roomId,
      serviceIds,
      participants,
    }) {
      const current = await repository.current(requireTenantId(tenantId));
      const policy = evaluateTenantBookingPolicy(current.configuration, {
        operation,
        evaluationInstant: changedAt(clock),
        startsAt,
        siteId,
        roomId,
        serviceIds,
        participants,
      });
      return Object.freeze({
        schemaVersion: TENANT_SETTINGS_SCHEMA_VERSION,
        configurationRevision: current.revision,
        ...policy,
      });
    },

    async evaluateSnapshotForRequest({
      tenantId,
      snapshot,
      operation,
      startsAt,
      siteId,
      roomId,
      serviceIds,
      participants,
    }) {
      requireTenantId(tenantId);
      const persisted = normalizePersistedSnapshot(snapshot);
      const evaluated = evaluateTenantBookingPolicySnapshot(persisted.policy, {
        operation,
        evaluationInstant: changedAt(clock),
        startsAt,
        siteId,
        roomId,
        serviceIds,
        participants,
      });
      return Object.freeze({
        schemaVersion: persisted.schemaVersion,
        configurationRevision: persisted.configurationRevision,
        ...evaluated,
      });
    },
  });
}
