import {
  authorizePlatformOperation,
  createMutationEvidence,
  createSensitiveReadEvidence,
  operationRequestDigest,
  PLATFORM_OPERATION,
  requireBoolean,
  requireClockTime,
  requireConfirmation,
  requireCount,
  requireExactObject,
  requireInternalId,
  requireLimit,
  requirePort,
  requireReason,
  requireRevision,
  requireSafeCode,
  requireTimestamp,
} from './platform-operation-contract.js';
import {
  PlatformOperationConflictError,
  PlatformOperationUnavailableError,
} from './platform-operation-errors.js';

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const LIFECYCLE_STATUSES = new Set(['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived']);
const CONNECTION_STATES = new Set(['not_configured', 'connected', 'degraded', 'disconnected', 'revoked']);
const USER_STATES = new Set(['active', 'disabled']);
const IDENTITY_STATES = new Set(['active', 'missing']);
const SUCCESS_OUTCOMES = new Set(['updated', 'idempotent']);
const TARGET_OPERATION = Object.freeze({
  'last-tenant-admin': PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
  'room-mapping-repair': PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
  'user-session-revocation': PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
});

function targetItem(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    unavailable('PLATFORM_RECOVERY_TARGET_PAGE_INVALID');
  }
  if (operation === 'room-mapping-repair') {
    requireExactObject(value, [
      'mappingId', 'eligible', 'mappingState', 'connectionState',
      'placesPermission', 'candidateCount',
    ]);
    return Object.freeze({
      mappingId: requireInternalId(value.mappingId, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      eligible: requireBoolean(value.eligible, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      mappingState: requireSafeCode(value.mappingState, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      connectionState: requireSafeCode(value.connectionState, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      placesPermission: requireSafeCode(value.placesPermission, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      candidateCount: requireCount(value.candidateCount, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
    });
  }
  const lastAdmin = operation === 'last-tenant-admin';
  requireExactObject(value, lastAdmin
    ? ['targetUserId', 'eligible', 'userState', 'activeSessionCount', 'identityState',
      'alreadyTenantAdmin', 'currentTenantAdminCount']
    : ['targetUserId', 'eligible', 'userState', 'activeSessionCount']);
  return Object.freeze({
    targetUserId: requireInternalId(value.targetUserId, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
    eligible: requireBoolean(value.eligible, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
    userState: requireSafeCode(value.userState, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
    activeSessionCount: requireCount(value.activeSessionCount, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
    ...(lastAdmin ? {
      identityState: requireSafeCode(value.identityState, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
      alreadyTenantAdmin: requireBoolean(
        value.alreadyTenantAdmin,
        'PLATFORM_RECOVERY_TARGET_PAGE_INVALID',
      ),
      currentTenantAdminCount: requireCount(
        value.currentTenantAdminCount,
        'PLATFORM_RECOVERY_TARGET_PAGE_INVALID',
      ),
    } : {}),
  });
}

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) unavailable(code);
  return value;
}

function impactCodes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  }
  const normalized = Object.freeze(value.map((item) => requireSafeCode(item, 'PLATFORM_RECOVERY_INSPECTION_INVALID')));
  if (new Set(normalized).size !== normalized.length) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  return normalized;
}

function requireEligible(value, code) {
  if (requireBoolean(value, 'PLATFORM_RECOVERY_INSPECTION_INVALID') !== true) {
    throw new PlatformOperationConflictError(code);
  }
}

function lastTenantAdminInspection(value, tenantId, targetUserId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_LAST_ADMIN_NOT_ELIGIBLE');
  const currentAdminCount = requireCount(value.currentTenantAdminCount, 'PLATFORM_RECOVERY_INSPECTION_INVALID');
  if (currentAdminCount !== 0) throw new PlatformOperationConflictError('PLATFORM_RECOVERY_LAST_ADMIN_NOT_REQUIRED');
  const stateBinding = Object.freeze({
    tenantRevision: requireRevision(value.tenantRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    userRevision: requireRevision(value.userRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    userState: requireEnum(value.userState, USER_STATES, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    identityState: requireEnum(value.identityState, IDENTITY_STATES, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    currentTenantAdminCount: currentAdminCount,
  });
  return Object.freeze({
    targetId: targetUserId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: Object.freeze({ tenantId, targetUserId, ...stateBinding }),
  });
}

function microsoftReconsentInspection(value, tenantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_RECONSENT_NOT_ELIGIBLE');
  const stateBinding = Object.freeze({
    connectionRevision: requireRevision(value.connectionRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    connectionState: requireEnum(value.connectionState, CONNECTION_STATES, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    customerAdminAvailable: requireBoolean(value.customerAdminAvailable, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
  });
  if (!stateBinding.customerAdminAvailable) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_CUSTOMER_ADMIN_REQUIRED');
  }
  return Object.freeze({
    targetId: tenantId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: stateBinding,
  });
}

function mappingRepairInspection(value, mappingId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_MAPPING_NOT_ELIGIBLE');
  const candidateCount = requireCount(value.candidateCount, 'PLATFORM_RECOVERY_INSPECTION_INVALID');
  const deterministic = requireBoolean(value.deterministic, 'PLATFORM_RECOVERY_INSPECTION_INVALID');
  if (!deterministic || candidateCount !== 1) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_MAPPING_AMBIGUOUS');
  }
  const stateBinding = Object.freeze({
    mappingRevision: requireRevision(value.mappingRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    connectionRevision: requireRevision(value.connectionRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    candidateCount,
    deterministic,
  });
  return Object.freeze({
    targetId: mappingId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: stateBinding,
  });
}

function identityUnbindInspection(value, tenantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_IDENTITY_UNBIND_NOT_ELIGIBLE');
  const nonTerminalReferenceCount = requireCount(
    value.nonTerminalReferenceCount,
    'PLATFORM_RECOVERY_INSPECTION_INVALID',
  );
  if (nonTerminalReferenceCount !== 0) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_NONTERMINAL_REFERENCES');
  }
  const stateBinding = Object.freeze({
    bindingRevision: requireRevision(value.bindingRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    lifecycleRevision: requireRevision(value.lifecycleRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    lifecycleStatus: requireEnum(value.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    nonTerminalReferenceCount,
    activeCustomerSessionCount: requireCount(
      value.activeCustomerSessionCount,
      'PLATFORM_RECOVERY_INSPECTION_INVALID',
    ),
  });
  return Object.freeze({
    targetId: tenantId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: stateBinding,
  });
}

function sessionInspection(value, targetId, { user = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_SESSION_REVOCATION_NOT_ELIGIBLE');
  const stateBinding = Object.freeze({
    securityRevision: requireRevision(value.securityRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    activeSessionCount: requireCount(value.activeSessionCount, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    ...(user ? { userRevision: requireRevision(value.userRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID') } : {}),
  });
  return Object.freeze({
    targetId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: stateBinding,
  });
}

function lifecycleInspection(value, tenantId, targetStatus, lifecyclePolicy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_INSPECTION_INVALID');
  requireEligible(value.eligible, 'PLATFORM_RECOVERY_LIFECYCLE_NOT_ELIGIBLE');
  const currentStatus = requireEnum(value.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_RECOVERY_INSPECTION_INVALID');
  lifecyclePolicy.requireTransition({ currentStatus, targetStatus });
  const stateBinding = Object.freeze({
    lifecycleRevision: requireRevision(value.lifecycleRevision, 'PLATFORM_RECOVERY_INSPECTION_INVALID'),
    lifecycleStatus: currentStatus,
    targetStatus,
  });
  return Object.freeze({
    targetId: tenantId,
    stateBinding,
    impactCodes: impactCodes(value.impactCodes),
    publicState: stateBinding,
  });
}

function requirePreviewBase(value, additionalKeys = []) {
  requireExactObject(value, ['operatorContext', 'tenantId', 'correlationId', ...additionalKeys]);
  return Object.freeze({
    operatorContext: value.operatorContext,
    tenantId: requireInternalId(value.tenantId, 'PLATFORM_TENANT_ID_INVALID'),
    correlationId: requireInternalId(value.correlationId, 'PLATFORM_CORRELATION_ID_INVALID'),
  });
}

function requireExecutionBase(value, operation, additionalKeys = []) {
  requireExactObject(value, [
    'operatorContext',
    'tenantId',
    'recoveryContextId',
    'reason',
    'confirmation',
    'correlationId',
    'idempotencyKey',
    ...additionalKeys,
  ]);
  const tenantId = requireInternalId(value.tenantId, 'PLATFORM_TENANT_ID_INVALID');
  return Object.freeze({
    operatorContext: value.operatorContext,
    tenantId,
    recoveryContextId: requireInternalId(value.recoveryContextId, 'PLATFORM_RECOVERY_CONTEXT_ID_INVALID'),
    reason: requireReason(value.reason),
    confirmation: requireConfirmation(value.confirmation, { action: operation, tenantId }),
    correlationId: requireInternalId(value.correlationId, 'PLATFORM_CORRELATION_ID_INVALID'),
    idempotencyKey: requireInternalId(value.idempotencyKey, 'PLATFORM_IDEMPOTENCY_KEY_INVALID'),
  });
}

function contextRecord(value, { operation, tenantId, targetId, nowMs }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_CONTEXT_INVALID');
  }
  if (
    requireInternalId(value.contextId, 'PLATFORM_RECOVERY_CONTEXT_INVALID') !== value.contextId
    || value.operation !== operation
    || requireInternalId(value.tenantId, 'PLATFORM_RECOVERY_CONTEXT_INVALID') !== tenantId
    || requireInternalId(value.targetId, 'PLATFORM_RECOVERY_CONTEXT_INVALID') !== targetId
    || value.used !== false
    || Date.parse(requireTimestamp(value.expiresAt, 'PLATFORM_RECOVERY_CONTEXT_INVALID')) <= nowMs
    || !value.stateBinding
    || typeof value.stateBinding !== 'object'
    || Array.isArray(value.stateBinding)
  ) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_CONTEXT_INVALID');
  }
  return Object.freeze({
    contextId: value.contextId,
    operation,
    tenantId,
    targetId,
    stateBinding: Object.freeze({ ...value.stateBinding }),
    expiresAt: value.expiresAt,
  });
}

function requireTransactionOutcome(value, sanitizer) {
  if (value?.outcome === 'idempotency_conflict') {
    throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
  }
  if (['stale', 'expired', 'used', 'wrong_actor', 'wrong_action', 'not_found'].includes(value?.outcome)) {
    throw new PlatformOperationConflictError('PLATFORM_RECOVERY_CONTEXT_INVALID');
  }
  if (value?.outcome === 'ambiguous') throw new PlatformOperationConflictError('PLATFORM_RECOVERY_MAPPING_AMBIGUOUS');
  if (!value || !SUCCESS_OUTCOMES.has(value.outcome)) unavailable('PLATFORM_RECOVERY_TRANSACTION_RESULT_INVALID');
  return Object.freeze({
    schemaVersion: 1,
    outcome: value.outcome,
    result: sanitizer(value.result),
  });
}

function recoveredAdminResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'tenant_admin_recovered') {
    unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  }
  return Object.freeze({
    status: value.status,
    tenantRevision: requireRevision(value.tenantRevision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    userRevision: requireRevision(value.userRevision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    revokedSessionCount: requireCount(value.revokedSessionCount, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

function reconsentResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'customer_action_required') {
    unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  }
  return Object.freeze({
    status: value.status,
    handoffId: requireInternalId(value.handoffId, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    expiresAt: requireTimestamp(value.expiresAt, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

function mappingRepairResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'repaired') {
    unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  }
  return Object.freeze({
    status: value.status,
    mappingRevision: requireRevision(value.mappingRevision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

function identityUnbindResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'unbound') {
    unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  }
  return Object.freeze({
    status: value.status,
    bindingRevision: requireRevision(value.bindingRevision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    revokedSessionCount: requireCount(value.revokedSessionCount, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

function sessionRevocationResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.status !== 'revoked') {
    unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  }
  return Object.freeze({
    status: value.status,
    revokedSessionCount: requireCount(value.revokedSessionCount, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    securityRevision: requireRevision(value.securityRevision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

function lifecycleResult(value, tenantId, targetStatus) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  if (
    requireInternalId(value.tenantId, 'PLATFORM_RECOVERY_RESULT_INVALID') !== tenantId
    || value.status !== targetStatus
  ) unavailable('PLATFORM_RECOVERY_RESULT_INVALID');
  return Object.freeze({
    tenantId,
    status: targetStatus,
    revision: requireRevision(value.revision, 'PLATFORM_RECOVERY_RESULT_INVALID'),
    changedAt: requireTimestamp(value.changedAt, 'PLATFORM_RECOVERY_RESULT_INVALID'),
  });
}

export function createPlatformRecoveryOperationsService({
  recoveryInspector,
  recoveryTargetReader,
  recoveryContextReader,
  recoveryContextTransactions,
  operationReceiptReader,
  lifecyclePolicy,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  operationEvidenceFactory,
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
  clock = () => Date.now(),
} = {}) {
  requirePort(recoveryInspector, [
    'lastTenantAdmin',
    'microsoftReconsent',
    'roomMappingRepair',
    'identityUnbind',
    'tenantSessionRevocation',
    'userSessionRevocation',
    'tenantLifecycle',
  ], 'PLATFORM_RECOVERY_INSPECTOR_REQUIRED');
  requirePort(recoveryTargetReader, ['list'], 'PLATFORM_RECOVERY_TARGET_READER_REQUIRED');
  requirePort(recoveryContextReader, ['findForExecution'], 'PLATFORM_RECOVERY_CONTEXT_READER_REQUIRED');
  requirePort(recoveryContextTransactions, [
    'issue',
    'executeLastTenantAdmin',
    'executeMicrosoftReconsent',
    'executeRoomMappingRepair',
    'executeIdentityUnbind',
    'executeTenantSessionRevocation',
    'executeUserSessionRevocation',
    'executeTenantLifecycle',
  ], 'PLATFORM_RECOVERY_TRANSACTIONS_REQUIRED');
  requirePort(operationReceiptReader, ['find'], 'PLATFORM_OPERATION_RECEIPT_READER_REQUIRED');
  requirePort(lifecyclePolicy, ['requireTransition'], 'PLATFORM_LIFECYCLE_POLICY_REQUIRED');
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(tenantTargetPolicy, ['authorize'], 'PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  requirePort(
    operationEvidenceFactory,
    ['createMutation', 'createSensitiveRead'],
    'PLATFORM_OPERATION_EVIDENCE_FACTORY_REQUIRED',
  );
  if (!Number.isSafeInteger(previewTtlMs) || previewTtlMs < 60_000 || previewTtlMs > 15 * 60 * 1000) {
    throw new TypeError('PLATFORM_RECOVERY_PREVIEW_TTL_INVALID');
  }
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  async function preview({ values, operation, inspect }) {
    const authorization = await authorizePlatformOperation({
      authorizationPolicy: platformAuthorizationPolicy,
      tenantTargetPolicy,
      operatorContext: values.operatorContext,
      operation,
      tenantId: values.tenantId,
    });
    const inspection = await inspect();
    const nowMs = requireClockTime(clock);
    const occurredAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + previewTtlMs).toISOString();
    const evidence = await createSensitiveReadEvidence({
      evidenceFactory: operationEvidenceFactory,
      authorization,
      operation,
      tenantId: values.tenantId,
      correlationId: values.correlationId,
      target: Object.freeze({ type: 'tenant_recovery_preview', id: inspection.targetId }),
      occurredAt,
    });
    const issued = await recoveryContextTransactions.issue({
      operation,
      tenantId: values.tenantId,
      targetId: inspection.targetId,
      stateBinding: inspection.stateBinding,
      impactCodes: inspection.impactCodes,
      authorization,
      evidence,
      correlationId: values.correlationId,
      occurredAt,
      expiresAt,
    });
    if (!issued || typeof issued !== 'object' || Array.isArray(issued)) unavailable('PLATFORM_RECOVERY_CONTEXT_INVALID');
    return Object.freeze({
      schemaVersion: 1,
      action: operation,
      recoveryContextId: requireInternalId(issued.contextId, 'PLATFORM_RECOVERY_CONTEXT_INVALID'),
      expiresAt: requireTimestamp(issued.expiresAt, 'PLATFORM_RECOVERY_CONTEXT_INVALID'),
      targetId: inspection.targetId,
      state: inspection.publicState,
      impactCodes: inspection.impactCodes,
    });
  }

  async function execute({ values, operation, targetId, transaction, sanitize, requestedState }) {
    const authorization = await authorizePlatformOperation({
      authorizationPolicy: platformAuthorizationPolicy,
      tenantTargetPolicy,
      operatorContext: values.operatorContext,
      operation,
      tenantId: values.tenantId,
    });
    const requestDigest = operationRequestDigest({
      operation,
      tenantId: values.tenantId,
      targetId,
      recoveryContextId: values.recoveryContextId,
      reason: values.reason,
    });
    const replay = await operationReceiptReader.find({
      authorization,
      operation,
      tenantId: values.tenantId,
      idempotencyKey: values.idempotencyKey,
    });
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
      }
      return Object.freeze({ schemaVersion: 1, outcome: 'idempotent', result: sanitize(replay.result) });
    }
    const nowMs = requireClockTime(clock);
    const context = contextRecord(await recoveryContextReader.findForExecution({
      authorization,
      contextId: values.recoveryContextId,
    }), { operation, tenantId: values.tenantId, targetId, nowMs });
    if (context.contextId !== values.recoveryContextId) {
      throw new PlatformOperationConflictError('PLATFORM_RECOVERY_CONTEXT_INVALID');
    }
    const occurredAt = new Date(nowMs).toISOString();
    const evidence = await createMutationEvidence({
      evidenceFactory: operationEvidenceFactory,
      authorization,
      operation,
      tenantId: values.tenantId,
      correlationId: values.correlationId,
      reason: values.reason,
      target: Object.freeze({ type: 'tenant_recovery', id: targetId }),
      previousState: context.stateBinding,
      requestedState,
      occurredAt,
    });
    return requireTransactionOutcome(await transaction({
      operation,
      tenantId: values.tenantId,
      targetId,
      contextId: values.recoveryContextId,
      expectedStateBinding: context.stateBinding,
      reason: values.reason,
      correlationId: values.correlationId,
      idempotencyKey: values.idempotencyKey,
      requestDigest,
      authorization,
      evidence,
      occurredAt,
    }), sanitize);
  }

  return Object.freeze({
    async listRecoveryTargets(input) {
      requireExactObject(input, [
        'operatorContext', 'tenantId', 'operation', 'limit', 'cursor', 'correlationId',
      ]);
      const operation = TARGET_OPERATION[input.operation];
      if (!operation) unavailable('PLATFORM_RECOVERY_TARGET_OPERATION_INVALID');
      const tenantId = requireInternalId(input.tenantId, 'PLATFORM_RECOVERY_TENANT_ID_INVALID');
      const limit = requireLimit(input.limit);
      if (input.cursor !== null && typeof input.cursor !== 'string') {
        unavailable('PLATFORM_RECOVERY_TARGET_CURSOR_INVALID');
      }
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation,
        tenantId,
      });
      const occurredAt = new Date(requireClockTime(clock)).toISOString();
      const evidence = await createSensitiveReadEvidence({
        evidenceFactory: operationEvidenceFactory,
        authorization,
        operation,
        tenantId,
        correlationId: requireInternalId(input.correlationId, 'PLATFORM_CORRELATION_ID_INVALID'),
        target: Object.freeze({ type: 'tenant_recovery_targets', id: tenantId }),
        occurredAt,
      });
      const page = await recoveryTargetReader.list({
        tenantId,
        operation: input.operation,
        limit,
        cursor: input.cursor,
        authorization,
        evidence,
      });
      if (
        !page
        || typeof page !== 'object'
        || !Array.isArray(page.items)
        || page.items.length > limit
        || (page.nextCursor !== null && typeof page.nextCursor !== 'string')
      ) unavailable('PLATFORM_RECOVERY_TARGET_PAGE_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        tenantId,
        operation: input.operation,
        snapshotAt: requireTimestamp(page.snapshotAt, 'PLATFORM_RECOVERY_TARGET_PAGE_INVALID'),
        items: Object.freeze(page.items.map((item) => targetItem(item, input.operation))),
        nextCursor: page.nextCursor,
      });
    },

    async previewLastTenantAdmin(input) {
      const values = requirePreviewBase(input, ['targetUserId']);
      const targetUserId = requireInternalId(input.targetUserId, 'PLATFORM_RECOVERY_USER_ID_INVALID');
      return preview({
        values,
        operation: PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
        inspect: async () => lastTenantAdminInspection(
          await recoveryInspector.lastTenantAdmin({ tenantId: values.tenantId, targetUserId }),
          values.tenantId,
          targetUserId,
        ),
      });
    },

    recoverLastTenantAdmin(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, ['targetUserId']);
      const targetUserId = requireInternalId(input.targetUserId, 'PLATFORM_RECOVERY_USER_ID_INVALID');
      return execute({
        values,
        operation: PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN,
        targetId: targetUserId,
        transaction: (entry) => recoveryContextTransactions.executeLastTenantAdmin(entry),
        sanitize: recoveredAdminResult,
        requestedState: Object.freeze({ status: 'tenant_admin_recovered' }),
      });
    },

    async previewMicrosoftReconsent(input) {
      const values = requirePreviewBase(input);
      return preview({
        values,
        operation: PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
        inspect: async () => microsoftReconsentInspection(
          await recoveryInspector.microsoftReconsent({ tenantId: values.tenantId }),
          values.tenantId,
        ),
      });
    },

    initiateMicrosoftReconsent(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT);
      return execute({
        values,
        operation: PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT,
        targetId: values.tenantId,
        transaction: (entry) => recoveryContextTransactions.executeMicrosoftReconsent(entry),
        sanitize: reconsentResult,
        requestedState: Object.freeze({ status: 'customer_action_required' }),
      });
    },

    async previewRoomMappingRepair(input) {
      const values = requirePreviewBase(input, ['mappingId']);
      const mappingId = requireInternalId(input.mappingId, 'PLATFORM_RECOVERY_MAPPING_ID_INVALID');
      return preview({
        values,
        operation: PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
        inspect: async () => mappingRepairInspection(
          await recoveryInspector.roomMappingRepair({ tenantId: values.tenantId, mappingId }),
          mappingId,
        ),
      });
    },

    repairRoomMapping(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.REPAIR_ROOM_MAPPING, ['mappingId']);
      const mappingId = requireInternalId(input.mappingId, 'PLATFORM_RECOVERY_MAPPING_ID_INVALID');
      return execute({
        values,
        operation: PLATFORM_OPERATION.REPAIR_ROOM_MAPPING,
        targetId: mappingId,
        transaction: (entry) => recoveryContextTransactions.executeRoomMappingRepair(entry),
        sanitize: mappingRepairResult,
        requestedState: Object.freeze({ status: 'repaired' }),
      });
    },

    async previewIdentityUnbind(input) {
      const values = requirePreviewBase(input);
      return preview({
        values,
        operation: PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
        inspect: async () => identityUnbindInspection(
          await recoveryInspector.identityUnbind({ tenantId: values.tenantId }),
          values.tenantId,
        ),
      });
    },

    unbindTenantIdentity(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY);
      return execute({
        values,
        operation: PLATFORM_OPERATION.UNBIND_TENANT_IDENTITY,
        targetId: values.tenantId,
        transaction: (entry) => recoveryContextTransactions.executeIdentityUnbind(entry),
        sanitize: identityUnbindResult,
        requestedState: Object.freeze({ status: 'unbound' }),
      });
    },

    async previewTenantSessionRevocation(input) {
      const values = requirePreviewBase(input);
      return preview({
        values,
        operation: PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS,
        inspect: async () => sessionInspection(
          await recoveryInspector.tenantSessionRevocation({ tenantId: values.tenantId }),
          values.tenantId,
        ),
      });
    },

    revokeTenantSessions(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS);
      return execute({
        values,
        operation: PLATFORM_OPERATION.REVOKE_TENANT_SESSIONS,
        targetId: values.tenantId,
        transaction: (entry) => recoveryContextTransactions.executeTenantSessionRevocation(entry),
        sanitize: sessionRevocationResult,
        requestedState: Object.freeze({ status: 'revoked' }),
      });
    },

    async previewUserSessionRevocation(input) {
      const values = requirePreviewBase(input, ['targetUserId']);
      const targetUserId = requireInternalId(input.targetUserId, 'PLATFORM_RECOVERY_USER_ID_INVALID');
      return preview({
        values,
        operation: PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
        inspect: async () => sessionInspection(
          await recoveryInspector.userSessionRevocation({ tenantId: values.tenantId, targetUserId }),
          targetUserId,
          { user: true },
        ),
      });
    },

    revokeUserSessions(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.REVOKE_USER_SESSIONS, ['targetUserId']);
      const targetUserId = requireInternalId(input.targetUserId, 'PLATFORM_RECOVERY_USER_ID_INVALID');
      return execute({
        values,
        operation: PLATFORM_OPERATION.REVOKE_USER_SESSIONS,
        targetId: targetUserId,
        transaction: (entry) => recoveryContextTransactions.executeUserSessionRevocation(entry),
        sanitize: sessionRevocationResult,
        requestedState: Object.freeze({ status: 'revoked' }),
      });
    },

    async previewTenantSuspension(input) {
      const values = requirePreviewBase(input);
      return preview({
        values,
        operation: PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT,
        inspect: async () => lifecycleInspection(
          await recoveryInspector.tenantLifecycle({ tenantId: values.tenantId }),
          values.tenantId,
          'suspended',
          lifecyclePolicy,
        ),
      });
    },

    suspendTenant(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT);
      return execute({
        values,
        operation: PLATFORM_OPERATION.RECOVERY_SUSPEND_TENANT,
        targetId: values.tenantId,
        transaction: (entry) => recoveryContextTransactions.executeTenantLifecycle({ ...entry, targetStatus: 'suspended' }),
        sanitize: (result) => lifecycleResult(result, values.tenantId, 'suspended'),
        requestedState: Object.freeze({ status: 'suspended' }),
      });
    },

    async previewTenantReactivation(input) {
      const values = requirePreviewBase(input);
      return preview({
        values,
        operation: PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
        inspect: async () => lifecycleInspection(
          await recoveryInspector.tenantLifecycle({ tenantId: values.tenantId }),
          values.tenantId,
          'active',
          lifecyclePolicy,
        ),
      });
    },

    reactivateTenant(input) {
      const values = requireExecutionBase(input, PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT);
      return execute({
        values,
        operation: PLATFORM_OPERATION.RECOVERY_REACTIVATE_TENANT,
        targetId: values.tenantId,
        transaction: (entry) => recoveryContextTransactions.executeTenantLifecycle({ ...entry, targetStatus: 'active' }),
        sanitize: (result) => lifecycleResult(result, values.tenantId, 'active'),
        requestedState: Object.freeze({ status: 'active' }),
      });
    },
  });
}
