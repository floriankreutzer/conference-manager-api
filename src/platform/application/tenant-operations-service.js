import {
  authorizePlatformOperation,
  createMutationEvidence,
  PLATFORM_OPERATION,
  requireBoundedText,
  requireClockTime,
  requireConfirmation,
  requireCursor,
  requireDisplayName,
  requireExactObject,
  requireInternalId,
  requireLimit,
  operationRequestDigest,
  requirePage,
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

const LIFECYCLE_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const LIFECYCLE_TARGETS = new Set(['ready', 'active', 'suspended', 'archived']);
const ONBOARDING_STATES = new Set(['not_started', 'invited', 'claim_pending', 'claimed', 'complete']);
const IDENTITY_STATES = new Set(['unbound', 'pending', 'active']);
const INVITATION_STATES = new Set(['none', 'open', 'expired', 'revoked', 'consumed']);
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITATION_HASH_PATTERN = /^[0-9a-f]{64}$/;
const DIRECTORY_SEARCH_PATTERN = /^[^\u0000-\u001f\u007f]{1,160}$/;

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new PlatformOperationUnavailableError(code);
  }
  return value;
}

function tenantSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationUnavailableError('PLATFORM_TENANT_RESULT_INVALID');
  }
  const invitationState = requireEnum(
    value.invitationState,
    INVITATION_STATES,
    'PLATFORM_TENANT_RESULT_INVALID',
  );
  const invitationId = value.invitationId === null
    ? null
    : requireInternalId(value.invitationId, 'PLATFORM_TENANT_RESULT_INVALID');
  const invitationRevision = value.invitationRevision === null
    ? null
    : requireRevision(value.invitationRevision, 'PLATFORM_TENANT_RESULT_INVALID');
  const invitationExpiresAt = value.invitationExpiresAt === null
    ? null
    : requireTimestamp(value.invitationExpiresAt, 'PLATFORM_TENANT_RESULT_INVALID');
  if (
    (invitationState === 'none') !== (invitationId === null)
    || (invitationState === 'none') !== (invitationRevision === null)
    || (invitationState === 'none') !== (invitationExpiresAt === null)
  ) {
    throw new PlatformOperationUnavailableError('PLATFORM_TENANT_RESULT_INVALID');
  }
  return Object.freeze({
    tenantId: requireInternalId(value.tenantId, 'PLATFORM_TENANT_RESULT_INVALID'),
    displayName: requireDisplayName(value.displayName),
    lifecycle: Object.freeze({
      status: requireEnum(value.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_TENANT_RESULT_INVALID'),
      revision: requireRevision(value.lifecycleRevision, 'PLATFORM_TENANT_RESULT_INVALID'),
    }),
    onboardingState: requireEnum(value.onboardingState, ONBOARDING_STATES, 'PLATFORM_TENANT_RESULT_INVALID'),
    identityState: requireEnum(value.identityState, IDENTITY_STATES, 'PLATFORM_TENANT_RESULT_INVALID'),
    invitation: Object.freeze({
      id: invitationId,
      state: invitationState,
      revision: invitationRevision,
      expiresAt: invitationExpiresAt,
    }),
    updatedAt: requireTimestamp(value.updatedAt, 'PLATFORM_TENANT_RESULT_INVALID'),
  });
}

function lifecycleResult(value, tenantId, targetStatus) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationUnavailableError('PLATFORM_LIFECYCLE_RESULT_INVALID');
  }
  const resultTenantId = requireInternalId(value.tenantId, 'PLATFORM_LIFECYCLE_RESULT_INVALID');
  const status = requireEnum(value.status, LIFECYCLE_STATUSES, 'PLATFORM_LIFECYCLE_RESULT_INVALID');
  if (resultTenantId !== tenantId || status !== targetStatus) {
    throw new PlatformOperationUnavailableError('PLATFORM_LIFECYCLE_RESULT_INVALID');
  }
  return Object.freeze({
    tenantId,
    status,
    revision: requireRevision(value.revision, 'PLATFORM_LIFECYCLE_RESULT_INVALID'),
    changedAt: requireTimestamp(value.changedAt, 'PLATFORM_LIFECYCLE_RESULT_INVALID'),
  });
}

function invitationResult(value, expectedState, expectedInvitationId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_RESULT_INVALID');
  }
  const state = requireEnum(value.state, INVITATION_STATES, 'PLATFORM_INVITATION_RESULT_INVALID');
  if (state !== expectedState) {
    throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_RESULT_INVALID');
  }
  const invitationId = requireInternalId(value.invitationId, 'PLATFORM_INVITATION_RESULT_INVALID');
  if (expectedInvitationId !== null && invitationId !== expectedInvitationId) {
    throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_RESULT_INVALID');
  }
  return Object.freeze({
    invitationId,
    state,
    revision: requireRevision(value.revision, 'PLATFORM_INVITATION_RESULT_INVALID'),
    expiresAt: value.expiresAt === null
      ? null
      : requireTimestamp(value.expiresAt, 'PLATFORM_INVITATION_RESULT_INVALID'),
  });
}

function requireCreateConfirmation(value, displayName) {
  requireExactObject(
    value,
    ['action', 'displayName'],
    ['action', 'displayName'],
    'PLATFORM_OPERATION_CONFIRMATION_INVALID',
  );
  if (
    value.action !== PLATFORM_OPERATION.TENANT_INVITATION_CREATE
    || value.displayName !== displayName
  ) {
    throw new PlatformOperationConflictError('PLATFORM_OPERATION_CONFIRMATION_INVALID');
  }
  return Object.freeze({ action: value.action, displayName });
}

function createdTenantResult(value, expectedTenantId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationUnavailableError('PLATFORM_TENANT_CREATE_RESULT_INVALID');
  }
  const tenantId = requireInternalId(value.tenantId, 'PLATFORM_TENANT_CREATE_RESULT_INVALID');
  if (expectedTenantId !== null && tenantId !== expectedTenantId) {
    throw new PlatformOperationUnavailableError('PLATFORM_TENANT_CREATE_RESULT_INVALID');
  }
  if (value.status !== 'pending') {
    throw new PlatformOperationUnavailableError('PLATFORM_TENANT_CREATE_RESULT_INVALID');
  }
  return Object.freeze({
    tenantId,
    displayName: requireDisplayName(value.displayName),
    status: 'pending',
    revision: requireRevision(value.revision, 'PLATFORM_TENANT_CREATE_RESULT_INVALID'),
    createdAt: requireTimestamp(value.createdAt, 'PLATFORM_TENANT_CREATE_RESULT_INVALID'),
  });
}

function requireMutationInput(value, action) {
  requireExactObject(value, [
    'operatorContext',
    'tenantId',
    'invitationId',
    'expectedRevision',
    'reason',
    'confirmation',
    'correlationId',
    'idempotencyKey',
  ]);
  const tenantId = requireInternalId(value.tenantId, 'PLATFORM_TENANT_ID_INVALID');
  return Object.freeze({
    operatorContext: value.operatorContext,
    tenantId,
    invitationId: requireInternalId(value.invitationId, 'PLATFORM_INVITATION_ID_INVALID'),
    expectedRevision: requireRevision(value.expectedRevision),
    reason: requireReason(value.reason),
    confirmation: requireConfirmation(value.confirmation, { action, tenantId }),
    correlationId: requireInternalId(value.correlationId, 'PLATFORM_CORRELATION_ID_INVALID'),
    idempotencyKey: requireInternalId(value.idempotencyKey, 'PLATFORM_IDEMPOTENCY_KEY_INVALID'),
  });
}

function currentInvitation(value, expectedTenantId, expectedInvitationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformOperationConflictError('PLATFORM_INVITATION_NOT_FOUND');
  }
  const tenantId = requireInternalId(value.tenantId, 'PLATFORM_INVITATION_STATE_INVALID');
  const invitationId = requireInternalId(value.invitationId, 'PLATFORM_INVITATION_STATE_INVALID');
  if (tenantId !== expectedTenantId || invitationId !== expectedInvitationId) {
    throw new PlatformOperationConflictError('PLATFORM_INVITATION_NOT_FOUND');
  }
  return Object.freeze({
    tenantId,
    invitationId,
    state: requireEnum(value.state, INVITATION_STATES, 'PLATFORM_INVITATION_STATE_INVALID'),
    revision: requireRevision(value.revision, 'PLATFORM_INVITATION_STATE_INVALID'),
    expiresAt: value.expiresAt === null
      ? null
      : requireTimestamp(value.expiresAt, 'PLATFORM_INVITATION_STATE_INVALID'),
  });
}

function requireUpdatedOutcome(result, staleCode) {
  if (result?.outcome === 'idempotency_conflict') {
    throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
  }
  if (result?.outcome === 'stale' || result?.outcome === 'not_open' || result?.outcome === 'not_found') {
    throw new PlatformOperationConflictError(staleCode);
  }
  if (!result || !['updated', 'idempotent'].includes(result.outcome)) {
    throw new PlatformOperationUnavailableError('PLATFORM_OPERATION_TRANSACTION_RESULT_INVALID');
  }
  return result;
}

export function createPlatformTenantOperationsService({
  directoryReader,
  invitationReader,
  invitationTransactions,
  lifecycleReader,
  lifecyclePolicy,
  lifecycleTransactions,
  operationReceiptReader,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  operationEvidenceFactory,
  idFactory,
  invitationSecretFactory,
  clock = () => Date.now(),
} = {}) {
  requirePort(directoryReader, ['list'], 'PLATFORM_TENANT_DIRECTORY_READER_REQUIRED');
  requirePort(invitationReader, ['findById'], 'PLATFORM_INVITATION_READER_REQUIRED');
  requirePort(invitationTransactions, ['create', 'revoke', 'reissue'], 'PLATFORM_INVITATION_TRANSACTIONS_REQUIRED');
  requirePort(lifecycleReader, ['findCurrent'], 'PLATFORM_LIFECYCLE_READER_REQUIRED');
  requirePort(lifecyclePolicy, ['requireTransition'], 'PLATFORM_LIFECYCLE_POLICY_REQUIRED');
  requirePort(lifecycleTransactions, ['compareAndSet'], 'PLATFORM_LIFECYCLE_TRANSACTIONS_REQUIRED');
  requirePort(operationReceiptReader, ['find'], 'PLATFORM_OPERATION_RECEIPT_READER_REQUIRED');
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(
    tenantTargetPolicy,
    ['authorize', 'authorizeCreation', 'queryScope'],
    'PLATFORM_TENANT_TARGET_POLICY_REQUIRED',
  );
  requirePort(operationEvidenceFactory, ['createMutation'], 'PLATFORM_OPERATION_EVIDENCE_FACTORY_REQUIRED');
  if (typeof idFactory !== 'function') throw new TypeError('PLATFORM_IDENTIFIER_FACTORY_REQUIRED');
  requirePort(invitationSecretFactory, ['issue'], 'PLATFORM_INVITATION_SECRET_FACTORY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  async function invitationMutation(input, operation, transaction, expectedState, {
    allowedCurrentStates = Object.freeze(['open']),
  } = {}) {
    const values = requireMutationInput(input, operation);
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
      invitationId: values.invitationId,
      expectedRevision: values.expectedRevision,
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
      return { values, result: Object.freeze({ outcome: 'idempotent', ...replay.result }), replay: true };
    }
    const current = currentInvitation(
      await invitationReader.findById(values.tenantId, values.invitationId),
      values.tenantId,
      values.invitationId,
    );
    if (current.revision !== values.expectedRevision || !allowedCurrentStates.includes(current.state)) {
      throw new PlatformOperationConflictError('PLATFORM_INVITATION_STALE');
    }
    const occurredAt = new Date(requireClockTime(clock)).toISOString();
    const evidence = await createMutationEvidence({
      evidenceFactory: operationEvidenceFactory,
      authorization,
      operation,
      tenantId: values.tenantId,
      correlationId: values.correlationId,
      reason: values.reason,
      target: Object.freeze({ type: 'tenant_invitation', id: values.invitationId }),
      previousState: Object.freeze({ state: current.state, revision: current.revision }),
      requestedState: Object.freeze({ state: expectedState }),
      occurredAt,
    });
    const result = requireUpdatedOutcome(await transaction({
      ...values,
      authorization,
      evidence,
      occurredAt,
      requestDigest,
    }), 'PLATFORM_INVITATION_STALE');
    return { values, result, replay: result.outcome === 'idempotent' };
  }

  return Object.freeze({
    async listDirectory(input) {
      requireExactObject(input, ['operatorContext', 'query']);
      requireExactObject(
        input.query,
        ['limit', 'cursor', 'lifecycleStatus', 'search'],
        [],
        'PLATFORM_TENANT_DIRECTORY_QUERY_INVALID',
      );
      const query = Object.freeze({
        limit: requireLimit(input.query.limit),
        cursor: input.query.cursor === undefined ? null : requireCursor(input.query.cursor),
        lifecycleStatus: input.query.lifecycleStatus === undefined
          ? null
          : requireEnum(input.query.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_TENANT_DIRECTORY_QUERY_INVALID'),
        search: input.query.search === undefined
          ? null
          : requireBoundedText(input.query.search, {
            maximum: 160,
            pattern: DIRECTORY_SEARCH_PATTERN,
            code: 'PLATFORM_TENANT_DIRECTORY_QUERY_INVALID',
          }),
      });
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.TENANT_DIRECTORY_READ,
        fleet: true,
      });
      const page = requirePage(await directoryReader.list({ query, authorization }));
      if (page.items.length > query.limit) {
        throw new PlatformOperationUnavailableError('PLATFORM_TENANT_DIRECTORY_PAGE_INVALID');
      }
      return Object.freeze({
        schemaVersion: 1,
        snapshotAt: page.snapshotAt,
        items: Object.freeze(page.items.map(tenantSummary)),
        nextCursor: page.nextCursor,
      });
    },

    async createTenantInvitation(input) {
      requireExactObject(input, [
        'operatorContext',
        'displayName',
        'reason',
        'confirmation',
        'correlationId',
        'idempotencyKey',
      ]);
      const displayName = requireDisplayName(input.displayName);
      const reason = requireReason(input.reason);
      requireCreateConfirmation(input.confirmation, displayName);
      const correlationId = requireInternalId(input.correlationId, 'PLATFORM_CORRELATION_ID_INVALID');
      const idempotencyKey = requireInternalId(input.idempotencyKey, 'PLATFORM_IDEMPOTENCY_KEY_INVALID');
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
        tenantCreation: true,
      });
      const requestDigest = operationRequestDigest({
        operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
        displayName,
        reason,
      });
      const replay = await operationReceiptReader.find({
        authorization,
        operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
        tenantId: null,
        idempotencyKey,
      });
      if (replay) {
        if (replay.requestDigest !== requestDigest) {
          throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
        }
        return Object.freeze({
          schemaVersion: 1,
          outcome: 'idempotent',
          tenant: createdTenantResult(replay.result?.tenant),
          invitation: invitationResult(replay.result?.invitation, 'open'),
          oneTimeDelivery: Object.freeze({ available: false }),
        });
      }
      const tenantId = requireInternalId(idFactory('tenant'), 'PLATFORM_TENANT_IDENTIFIER_FACTORY_INVALID');
      const invitationId = requireInternalId(idFactory('invitation'), 'PLATFORM_INVITATION_IDENTIFIER_FACTORY_INVALID');
      if (tenantId === invitationId) {
        throw new PlatformOperationUnavailableError('PLATFORM_IDENTIFIER_COLLISION');
      }
      const occurredAt = new Date(requireClockTime(clock)).toISOString();
      const secret = await invitationSecretFactory.issue({
        purpose: 'tenant_claim',
        tenantId,
        invitationId,
        issuedAt: occurredAt,
      });
      if (
        !secret
        || typeof secret !== 'object'
        || Array.isArray(secret)
        || typeof secret.token !== 'string'
        || !INVITATION_TOKEN_PATTERN.test(secret.token)
        || typeof secret.tokenHash !== 'string'
        || !INVITATION_HASH_PATTERN.test(secret.tokenHash)
      ) {
        throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_SECRET_INVALID');
      }
      const expiresAt = requireTimestamp(secret.expiresAt, 'PLATFORM_INVITATION_SECRET_INVALID');
      if (Date.parse(expiresAt) <= Date.parse(occurredAt)) {
        throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_SECRET_INVALID');
      }
      const evidence = await createMutationEvidence({
        evidenceFactory: operationEvidenceFactory,
        authorization,
        operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,
        tenantId,
        correlationId,
        reason,
        target: Object.freeze({ type: 'tenant', id: tenantId }),
        previousState: null,
        requestedState: Object.freeze({ status: 'pending', invitationState: 'open' }),
        occurredAt,
      });
      const result = await invitationTransactions.create({
        tenantId,
        displayName,
        invitationId,
        tokenHash: secret.tokenHash,
        expiresAt,
        reason,
        correlationId,
        idempotencyKey,
        requestDigest,
        authorization,
        evidence,
        occurredAt,
      });
      if (result?.outcome === 'identifier_conflict') {
        throw new PlatformOperationConflictError('PLATFORM_TENANT_IDENTIFIER_CONFLICT');
      }
      if (result?.outcome === 'idempotency_conflict') {
        throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
      }
      if (!result || !['updated', 'idempotent'].includes(result.outcome)) {
        throw new PlatformOperationUnavailableError('PLATFORM_TENANT_CREATE_TRANSACTION_RESULT_INVALID');
      }
      const createdTenant = createdTenantResult(
        result.tenant,
        result.outcome === 'updated' ? tenantId : null,
      );
      const invitation = invitationResult(
        result.invitation,
        'open',
        result.outcome === 'updated' ? invitationId : null,
      );
      return Object.freeze({
        schemaVersion: 1,
        outcome: result.outcome,
        tenant: createdTenant,
        invitation,
        oneTimeDelivery: result.outcome === 'idempotent'
          ? Object.freeze({ available: false })
          : Object.freeze({ available: true, token: secret.token, expiresAt: invitation.expiresAt }),
      });
    },

    async revokeInvitation(input) {
      const { result } = await invitationMutation(
        input,
        PLATFORM_OPERATION.INVITATION_REVOKE,
        (values) => invitationTransactions.revoke(values),
        'revoked',
      );
      return Object.freeze({
        schemaVersion: 1,
        outcome: result.outcome,
        invitation: invitationResult(result.invitation, 'revoked', input.invitationId.toLowerCase()),
      });
    },

    async reissueInvitation(input) {
      let oneTimeToken = null;
      const { result, replay } = await invitationMutation(
        input,
        PLATFORM_OPERATION.INVITATION_REISSUE,
        async (values) => {
          const invitationId = requireInternalId(
            idFactory('invitation'),
            'PLATFORM_INVITATION_IDENTIFIER_FACTORY_INVALID',
          );
          if (invitationId === values.invitationId || invitationId === values.tenantId) {
            throw new PlatformOperationUnavailableError('PLATFORM_IDENTIFIER_COLLISION');
          }
          const secret = await invitationSecretFactory.issue({
            purpose: 'tenant_claim',
            tenantId: values.tenantId,
            invitationId,
            supersedesInvitationId: values.invitationId,
            issuedAt: values.occurredAt,
          });
          if (
            !secret
            || typeof secret !== 'object'
            || Array.isArray(secret)
            || typeof secret.token !== 'string'
            || !INVITATION_TOKEN_PATTERN.test(secret.token)
            || typeof secret.tokenHash !== 'string'
            || !INVITATION_HASH_PATTERN.test(secret.tokenHash)
          ) {
            throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_SECRET_INVALID');
          }
          const expiresAt = requireTimestamp(secret.expiresAt, 'PLATFORM_INVITATION_SECRET_INVALID');
          if (Date.parse(expiresAt) <= Date.parse(values.occurredAt)) {
            throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_SECRET_INVALID');
          }
          oneTimeToken = secret.token;
          return invitationTransactions.reissue({
            ...values,
            newInvitationId: invitationId,
            tokenHash: secret.tokenHash,
            expiresAt,
          });
        },
        'revoked',
        { allowedCurrentStates: Object.freeze(['open', 'expired']) },
      );
      const invitation = invitationResult(result.invitation, 'open');
      if (invitation.invitationId === input.invitationId.toLowerCase()) {
        throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_RESULT_INVALID');
      }
      if (!replay && (typeof oneTimeToken !== 'string' || !INVITATION_TOKEN_PATTERN.test(oneTimeToken))) {
        throw new PlatformOperationUnavailableError('PLATFORM_INVITATION_SECRET_INVALID');
      }
      return Object.freeze({
        schemaVersion: 1,
        outcome: result.outcome,
        invitation,
        oneTimeDelivery: replay
          ? Object.freeze({ available: false })
          : Object.freeze({ available: true, token: oneTimeToken, expiresAt: invitation.expiresAt }),
      });
    },

    async transitionLifecycle(input) {
      requireExactObject(input, [
        'operatorContext',
        'tenantId',
        'targetStatus',
        'expectedRevision',
        'reason',
        'confirmation',
        'correlationId',
        'idempotencyKey',
      ]);
      const tenantId = requireInternalId(input.tenantId, 'PLATFORM_TENANT_ID_INVALID');
      const targetStatus = typeof input.targetStatus === 'string' && LIFECYCLE_TARGETS.has(input.targetStatus)
        ? input.targetStatus
        : null;
      if (!targetStatus) throw new PlatformOperationConflictError('PLATFORM_LIFECYCLE_TARGET_INVALID');
      const expectedRevision = requireRevision(input.expectedRevision);
      const reason = requireReason(input.reason);
      requireConfirmation(input.confirmation, {
        action: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
        tenantId,
      });
      const correlationId = requireInternalId(input.correlationId, 'PLATFORM_CORRELATION_ID_INVALID');
      const idempotencyKey = requireInternalId(input.idempotencyKey, 'PLATFORM_IDEMPOTENCY_KEY_INVALID');
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
        tenantId,
      });
      const requestDigest = operationRequestDigest({
        operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
        tenantId,
        targetStatus,
        expectedRevision,
        reason,
      });
      const replay = await operationReceiptReader.find({
        authorization,
        operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
        tenantId,
        idempotencyKey,
      });
      if (replay) {
        if (replay.requestDigest !== requestDigest) {
          throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
        }
        return Object.freeze({
          schemaVersion: 1,
          outcome: 'idempotent',
          lifecycle: lifecycleResult(replay.result?.tenant, tenantId, targetStatus),
        });
      }
      const current = await lifecycleReader.findCurrent(tenantId);
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new PlatformOperationConflictError('PLATFORM_TENANT_NOT_FOUND');
      }
      const currentStatus = requireEnum(current.status, LIFECYCLE_STATUSES, 'PLATFORM_LIFECYCLE_STATE_INVALID');
      const currentRevision = requireRevision(current.revision, 'PLATFORM_LIFECYCLE_STATE_INVALID');
      if (currentRevision !== expectedRevision || currentStatus === targetStatus) {
        throw new PlatformOperationConflictError('PLATFORM_LIFECYCLE_STALE');
      }
      if (currentStatus === 'archived' || (targetStatus === 'archived' && currentStatus !== 'suspended')) {
        throw new PlatformOperationConflictError('PLATFORM_LIFECYCLE_TRANSITION_DENIED');
      }
      if (targetStatus !== 'archived') {
        await lifecyclePolicy.requireTransition({ currentStatus, targetStatus });
      }
      const occurredAt = new Date(requireClockTime(clock)).toISOString();
      const evidence = await createMutationEvidence({
        evidenceFactory: operationEvidenceFactory,
        authorization,
        operation: PLATFORM_OPERATION.LIFECYCLE_TRANSITION,
        tenantId,
        correlationId,
        reason,
        target: Object.freeze({ type: 'tenant', id: tenantId }),
        previousState: Object.freeze({ status: currentStatus, revision: currentRevision }),
        requestedState: Object.freeze({ status: targetStatus }),
        occurredAt,
      });
      const result = await lifecycleTransactions.compareAndSet({
        tenantId,
        expectedRevision,
        expectedStatus: currentStatus,
        targetStatus,
        reason,
        correlationId,
        idempotencyKey,
        authorization,
        evidence,
        occurredAt,
        requestDigest,
      });
      if (result?.outcome === 'stale' || result?.outcome === 'not_ready') {
        throw new PlatformOperationConflictError(
          result.outcome === 'not_ready' ? 'PLATFORM_LIFECYCLE_NOT_READY' : 'PLATFORM_LIFECYCLE_STALE',
        );
      }
      if (result?.outcome === 'idempotency_conflict') {
        throw new PlatformOperationConflictError('PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
      }
      if (!result || !['updated', 'idempotent'].includes(result.outcome)) {
        throw new PlatformOperationUnavailableError('PLATFORM_LIFECYCLE_TRANSACTION_RESULT_INVALID');
      }
      return Object.freeze({
        schemaVersion: 1,
        outcome: result.outcome,
        lifecycle: lifecycleResult(result.tenant, tenantId, targetStatus),
      });
    },
  });
}
