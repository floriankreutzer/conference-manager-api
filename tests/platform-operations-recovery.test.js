import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { PlatformOperationConflictError } from '../src/platform/application/platform-operation-errors.js';
import { createPlatformRecoveryOperationsService } from '../src/platform/application/recovery-operations-service.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MAPPING_ID = '33333333-3333-4333-8333-333333333333';
const CONTEXT_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';
const HANDOFF_ID = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-08-28T12:00:00.000Z';

function executionInput(operation, overrides = {}) {
  return {
    operatorContext: {},
    tenantId: TENANT_ID,
    recoveryContextId: CONTEXT_ID,
    reason: 'Approved controlled recovery.',
    confirmation: { action: operation, tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function fixtures(overrides = {}) {
  const state = {
    receipt: null,
    context: null,
    contextReads: 0,
    inspections: 0,
    issues: 0,
    executions: 0,
    permissions: [],
  };
  const successful = (result) => async (values) => {
    state.executions += 1;
    state.executed = values;
    state.receipt = { requestDigest: values.requestDigest, result };
    if (state.context) state.context = { ...state.context, used: true };
    return { outcome: 'updated', result };
  };
  const recoveryInspector = {
    async lastTenantAdmin() {
      state.inspections += 1;
      return {
        eligible: true,
        tenantRevision: 9,
        userRevision: 3,
        userState: 'active',
        identityState: 'active',
        currentTenantAdminCount: 0,
        impactCodes: ['tenant_admin.restored', 'sessions.revoked'],
      };
    },
    async microsoftReconsent() {
      state.inspections += 1;
      return {
        eligible: true,
        connectionRevision: 4,
        connectionState: 'revoked',
        customerAdminAvailable: true,
        impactCodes: ['customer_consent.required'],
      };
    },
    async roomMappingRepair() {
      state.inspections += 1;
      return {
        eligible: true,
        mappingRevision: 5,
        connectionRevision: 4,
        candidateCount: 1,
        deterministic: true,
        impactCodes: ['room_mapping.repaired'],
      };
    },
    async identityUnbind() {
      state.inspections += 1;
      return {
        eligible: true,
        bindingRevision: 6,
        lifecycleRevision: 9,
        lifecycleStatus: 'onboarding',
        nonTerminalReferenceCount: 0,
        activeCustomerSessionCount: 2,
        impactCodes: ['identity.unbound', 'sessions.revoked'],
      };
    },
    async tenantSessionRevocation() {
      state.inspections += 1;
      return {
        eligible: true,
        securityRevision: 2,
        activeSessionCount: 4,
        impactCodes: ['sessions.revoked'],
      };
    },
    async userSessionRevocation() {
      state.inspections += 1;
      return {
        eligible: true,
        securityRevision: 2,
        userRevision: 3,
        activeSessionCount: 1,
        impactCodes: ['sessions.revoked'],
      };
    },
    async tenantLifecycle() {
      state.inspections += 1;
      return {
        eligible: true,
        lifecycleRevision: 9,
        lifecycleStatus: 'active',
        impactCodes: ['tenant.suspended'],
      };
    },
    ...overrides.recoveryInspector,
  };
  const recoveryContextTransactions = {
    async issue(values) {
      state.issues += 1;
      state.context = {
        contextId: CONTEXT_ID,
        operation: values.operation,
        tenantId: values.tenantId,
        targetId: values.targetId,
        stateBinding: values.stateBinding,
        expiresAt: values.expiresAt,
        used: false,
      };
      return { contextId: CONTEXT_ID, expiresAt: values.expiresAt };
    },
    executeLastTenantAdmin: successful({
      status: 'tenant_admin_recovered',
      tenantRevision: 10,
      userRevision: 4,
      revokedSessionCount: 2,
      email: 'must-not-leak',
    }),
    executeMicrosoftReconsent: successful({
      status: 'customer_action_required',
      handoffId: HANDOFF_ID,
      expiresAt: '2026-08-28T12:15:00.000Z',
      consentUrl: 'https://must-not-leak.example',
      providerToken: 'must-not-leak',
    }),
    executeRoomMappingRepair: successful({ status: 'repaired', mappingRevision: 6, resourceAddress: 'must-not-leak' }),
    executeIdentityUnbind: successful({ status: 'unbound', bindingRevision: 7, revokedSessionCount: 2 }),
    executeTenantSessionRevocation: successful({ status: 'revoked', revokedSessionCount: 4, securityRevision: 3 }),
    executeUserSessionRevocation: successful({ status: 'revoked', revokedSessionCount: 1, securityRevision: 3 }),
    executeTenantLifecycle: successful({ tenantId: TENANT_ID, status: 'suspended', revision: 10, changedAt: NOW }),
    ...overrides.recoveryContextTransactions,
  };
  const service = createPlatformRecoveryOperationsService({
    recoveryInspector,
    recoveryTargetReader: {
      async list() { return { items: [], nextCursor: null, snapshotAt: NOW }; },
      ...overrides.recoveryTargetReader,
    },
    recoveryContextReader: {
      async findForExecution() {
        state.contextReads += 1;
        return state.context;
      },
      ...overrides.recoveryContextReader,
    },
    recoveryContextTransactions,
    operationReceiptReader: {
      async find() { return state.receipt; },
      ...overrides.operationReceiptReader,
    },
    lifecyclePolicy: {
      requireTransition(values) {
        state.lifecycleTransition = values;
        return true;
      },
      ...overrides.lifecyclePolicy,
    },
    platformAuthorizationPolicy: {
      authorize(_principal, permission) {
        state.permissions.push(permission);
        return true;
      },
      ...overrides.platformAuthorizationPolicy,
    },
    tenantTargetPolicy: {
      async authorize(_principal, tenantId) {
        state.targetTenantIds ??= [];
        state.targetTenantIds.push(tenantId);
        return true;
      },
      ...overrides.tenantTargetPolicy,
    },
    operationEvidenceFactory: {
      async createMutation(values) { state.mutationEvidence = values; return { dualAudit: true }; },
      async createSensitiveRead(values) { state.readEvidence = values; return { platformAudit: true }; },
      ...overrides.operationEvidenceFactory,
    },
    clock: () => Date.parse(NOW),
  });
  return { service, state };
}

test('last-admin recovery uses an action-specific one-use context and safe idempotent replay', async () => {
  const { service, state } = fixtures();
  assert.equal(Object.hasOwn(service, 'execute'), false);
  assert.equal(Object.hasOwn(service, 'command'), false);
  const preview = await service.previewLastTenantAdmin({
    operatorContext: {},
    tenantId: TENANT_ID,
    targetUserId: USER_ID,
    correlationId: CORRELATION_ID,
  });
  assert.equal(preview.action, PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN);
  assert.equal(preview.targetId, USER_ID);
  assert.equal(state.permissions[0], PLATFORM_PERMISSION.RECOVERY_EXECUTE);
  assert.equal(state.issues, 1);

  const input = executionInput(PLATFORM_OPERATION.RECOVER_LAST_TENANT_ADMIN, { targetUserId: USER_ID });
  const first = await service.recoverLastTenantAdmin(input);
  assert.equal(first.result.status, 'tenant_admin_recovered');
  assert.doesNotMatch(JSON.stringify(first), /email|must-not-leak/);
  assert.equal(state.contextReads, 1);
  assert.equal(state.executions, 1);
  assert.deepEqual(state.mutationEvidence.previousState, {
    tenantRevision: 9,
    userRevision: 3,
    userState: 'active',
    identityState: 'active',
    currentTenantAdminCount: 0,
  });

  const replay = await service.recoverLastTenantAdmin(input);
  assert.equal(replay.outcome, 'idempotent');
  assert.equal(state.contextReads, 1, 'receipt lookup must precede the consumed-context check');
  assert.equal(state.executions, 1);

  await assert.rejects(
    service.recoverLastTenantAdmin({ ...input, reason: 'Different recovery payload.' }),
    (error) => error instanceof PlatformOperationConflictError && error.code === 'PLATFORM_IDEMPOTENCY_KEY_CONFLICT',
  );
});

test('authorization occurs before recovery inspection', async () => {
  const { service, state } = fixtures({
    platformAuthorizationPolicy: {
      authorize() { throw new PlatformAuthorizationError(); },
    },
  });
  await assert.rejects(service.previewLastTenantAdmin({
    operatorContext: {},
    tenantId: TENANT_ID,
    targetUserId: USER_ID,
    correlationId: CORRELATION_ID,
  }), /PLATFORM_AUTHORIZATION_DENIED/);
  assert.equal(state.inspections, 0);
  assert.equal(state.issues, 0);
});

test('recovery target discovery is Tenant-authorized, bounded, and operation-specific', async () => {
  const { service, state } = fixtures({
    recoveryTargetReader: {
      async list(input) {
        state.targetQuery = input;
        return {
          snapshotAt: NOW,
          items: [{
            targetUserId: USER_ID,
            eligible: true,
            userState: 'active',
            activeSessionCount: 1,
          }],
          nextCursor: null,
        };
      },
    },
  });
  const result = await service.listRecoveryTargets({
    operatorContext: {},
    tenantId: TENANT_ID,
    operation: 'user-session-revocation',
    limit: 25,
    cursor: null,
    correlationId: CORRELATION_ID,
  });
  assert.equal(result.items[0].targetUserId, USER_ID);
  assert.equal(state.targetQuery.tenantId, TENANT_ID);
  assert.equal(state.targetQuery.limit, 25);
  assert.equal(state.permissions[0], PLATFORM_PERMISSION.SESSION_REVOKE);
});

test('mapping ambiguity and nonterminal identity references fail before a context is issued', async () => {
  const ambiguous = fixtures({
    recoveryInspector: {
      async roomMappingRepair() {
        return {
          eligible: true,
          mappingRevision: 5,
          connectionRevision: 4,
          candidateCount: 2,
          deterministic: false,
          impactCodes: ['room_mapping.ambiguous'],
        };
      },
    },
  });
  await assert.rejects(ambiguous.service.previewRoomMappingRepair({
    operatorContext: {},
    tenantId: TENANT_ID,
    mappingId: MAPPING_ID,
    correlationId: CORRELATION_ID,
  }), (error) => error.code === 'PLATFORM_RECOVERY_MAPPING_AMBIGUOUS');
  assert.equal(ambiguous.state.issues, 0);

  const referenced = fixtures({
    recoveryInspector: {
      async identityUnbind() {
        return {
          eligible: true,
          bindingRevision: 6,
          lifecycleRevision: 9,
          lifecycleStatus: 'onboarding',
          nonTerminalReferenceCount: 1,
          activeCustomerSessionCount: 2,
          impactCodes: ['identity.unbound'],
        };
      },
    },
  });
  await assert.rejects(referenced.service.previewIdentityUnbind({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
  }), (error) => error.code === 'PLATFORM_RECOVERY_NONTERMINAL_REFERENCES');
  assert.equal(referenced.state.issues, 0);
});

test('Microsoft recovery creates only a customer reconsent handoff and never exposes consent material', async () => {
  const { service } = fixtures();
  await service.previewMicrosoftReconsent({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
  });
  const result = await service.initiateMicrosoftReconsent(
    executionInput(PLATFORM_OPERATION.INITIATE_MICROSOFT_RECONSENT),
  );
  assert.deepEqual(result.result, {
    status: 'customer_action_required',
    handoffId: HANDOFF_ID,
    expiresAt: '2026-08-28T12:15:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(result), /consentUrl|providerToken|must-not-leak/);
});

test('suspend and reactivate previews delegate transition validity to the canonical lifecycle policy', async () => {
  const suspended = fixtures();
  await suspended.service.previewTenantSuspension({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(suspended.state.lifecycleTransition, { currentStatus: 'active', targetStatus: 'suspended' });

  const reactivated = fixtures({
    recoveryInspector: {
      async tenantLifecycle() {
        return {
          eligible: true,
          lifecycleRevision: 10,
          lifecycleStatus: 'suspended',
          impactCodes: ['tenant.reactivated'],
        };
      },
    },
  });
  await reactivated.service.previewTenantReactivation({
    operatorContext: {},
    tenantId: TENANT_ID,
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(reactivated.state.lifecycleTransition, { currentStatus: 'suspended', targetStatus: 'active' });
});
