import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { PlatformOperationConflictError } from '../src/platform/application/platform-operation-errors.js';
import { createPlatformTenantOperationsService } from '../src/platform/application/tenant-operations-service.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import { PLATFORM_PERMISSION } from '../src/platform/identity/policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const INVITATION_ID = '22222222-2222-4222-8222-222222222222';
const NEW_INVITATION_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const IDEMPOTENCY_KEY = '55555555-5555-4555-8555-555555555555';
const OTHER_TENANT_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_IDEMPOTENCY_KEY = '88888888-8888-4888-8888-888888888888';
const NOW = '2026-08-28T12:00:00.000Z';
const EXPIRES_AT = '2026-08-29T12:00:00.000Z';
const TOKEN = 'a'.repeat(43);
const TOKEN_HASH = 'b'.repeat(64);

function mutationInput(action, overrides = {}) {
  return {
    operatorContext: { operatorId: 'trusted' },
    tenantId: TENANT_ID,
    invitationId: INVITATION_ID,
    expectedRevision: 3,
    reason: 'Requested by the tenant owner.',
    confirmation: { action, tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function fixtures(overrides = {}) {
  const state = {
    invitationReads: 0,
    lifecycleReads: 0,
    invitationWrites: 0,
    lifecycleWrites: 0,
    permissions: [],
    receipt: null,
    idCalls: 0,
    secretCalls: 0,
  };
  const service = createPlatformTenantOperationsService({
    directoryReader: {
      async list() {
        return {
          snapshotAt: NOW,
          nextCursor: null,
          items: [{
            tenantId: TENANT_ID,
            displayName: 'Northwind',
            lifecycleStatus: 'onboarding',
            lifecycleRevision: 2,
            onboardingState: 'invited',
            identityState: 'pending',
            invitationId: INVITATION_ID,
            invitationState: 'open',
            invitationRevision: 3,
            invitationExpiresAt: EXPIRES_AT,
            updatedAt: NOW,
            providerTenantReference: 'must-not-leak',
            invitationToken: 'must-not-leak',
          }],
        };
      },
    },
    invitationReader: {
      async findById() {
        state.invitationReads += 1;
        return {
          tenantId: TENANT_ID,
          invitationId: INVITATION_ID,
          state: 'open',
          revision: 3,
          expiresAt: EXPIRES_AT,
        };
      },
    },
    invitationTransactions: {
      async create(values) {
        state.invitationWrites += 1;
        state.created = values;
        const tenant = {
          tenantId: values.tenantId,
          displayName: values.displayName,
          status: 'pending',
          revision: 1,
          createdAt: NOW,
        };
        const invitation = {
          invitationId: values.invitationId,
          state: 'open',
          revision: 1,
          expiresAt: values.expiresAt,
        };
        state.receipt = { requestDigest: values.requestDigest, result: { tenant, invitation } };
        return { outcome: 'updated', tenant, invitation };
      },
      async revoke(values) {
        state.invitationWrites += 1;
        const invitation = { invitationId: INVITATION_ID, state: 'revoked', revision: 4, expiresAt: EXPIRES_AT };
        state.receipt = { requestDigest: values.requestDigest, result: { invitation } };
        return { outcome: 'updated', invitation };
      },
      async reissue(values) {
        state.invitationWrites += 1;
        state.reissued = values;
        const invitation = {
          invitationId: values.newInvitationId,
          state: 'open',
          revision: 1,
          expiresAt: values.expiresAt,
        };
        state.receipt = { requestDigest: values.requestDigest, result: { invitation } };
        return { outcome: 'updated', invitation };
      },
    },
    lifecycleReader: {
      async findCurrent() {
        state.lifecycleReads += 1;
        return { tenantId: TENANT_ID, status: 'suspended', revision: 7 };
      },
    },
    lifecyclePolicy: {
      requireTransition(values) {
        state.policyTransition = values;
        return true;
      },
    },
    lifecycleTransactions: {
      async compareAndSet(values) {
        state.lifecycleWrites += 1;
        state.lifecycleChanged = values;
        const tenant = { tenantId: TENANT_ID, status: values.targetStatus, revision: 8, changedAt: NOW };
        state.receipt = { requestDigest: values.requestDigest, result: { tenant } };
        return { outcome: 'updated', tenant };
      },
    },
    operationReceiptReader: {
      async find() { return state.receipt; },
    },
    platformAuthorizationPolicy: {
      authorize(_principal, permission) {
        state.permissions.push(permission);
        return true;
      },
    },
    tenantTargetPolicy: {
      async authorize(_principal, tenantId) {
        state.targetTenantIds ??= [];
        state.targetTenantIds.push(tenantId);
        return true;
      },
      async queryScope() {
        state.fleetScopeReads = (state.fleetScopeReads ?? 0) + 1;
        return { mode: 'all', securityVersion: 1, scopeKey: 'all-1' };
      },
      async authorizeCreation() {
        state.creationAuthorizations = (state.creationAuthorizations ?? 0) + 1;
        return true;
      },
    },
    operationEvidenceFactory: {
      async createMutation(values) {
        state.evidence = values;
        return { tenantAuditEvent: {}, platformAuditEvent: {} };
      },
    },
    idFactory(kind) {
      const value = kind === 'tenant'
        ? TENANT_ID
        : state.idCalls === 0 ? NEW_INVITATION_ID : INVITATION_ID;
      state.idCalls += 1;
      return value;
    },
    invitationSecretFactory: {
      async issue() {
        state.secretCalls += 1;
        return { token: TOKEN, tokenHash: TOKEN_HASH, expiresAt: EXPIRES_AT };
      },
    },
    clock: () => Date.parse(NOW),
    ...overrides,
  });
  return { service, state };
}

test('tenant directory is authorized, bounded, and projects only the minimized DTO', async () => {
  const { service, state } = fixtures();
  const result = await service.listDirectory({ operatorContext: {}, query: { limit: 10 } });
  assert.equal(state.permissions[0], PLATFORM_PERMISSION.TENANT_READ);
  assert.equal(state.fleetScopeReads, 1);
  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]), [
    'tenantId',
    'displayName',
    'lifecycle',
    'onboardingState',
    'identityState',
    'invitation',
    'updatedAt',
  ]);
  assert.doesNotMatch(JSON.stringify(result), /providerTenantReference|invitationToken|must-not-leak/);
  assert.equal(result.items[0].invitation.id, INVITATION_ID);
});

test('allowlist directory scope is applied by the reader before pagination and cursors cannot cross scopes', async () => {
  const rows = {
    'scope-a': { tenantId: TENANT_ID, displayName: 'Northwind' },
    'scope-b': { tenantId: OTHER_TENANT_ID, displayName: 'Contoso' },
  };
  const calls = [];
  const { service } = fixtures({
    tenantTargetPolicy: {
      async authorize() { return true; },
      async authorizeCreation() { return true; },
      async queryScope(principal) {
        return { mode: 'allowlist', securityVersion: 1, scopeKey: principal.scopeKey };
      },
    },
    directoryReader: {
      async list({ query, authorization }) {
        const scopeKey = authorization.targetAuthorization.scopeKey;
        calls.push({ scopeKey, cursor: query.cursor });
        if (query.cursor !== null && !query.cursor.startsWith(`${scopeKey}.`)) {
          throw new Error('CURSOR_SCOPE_MISMATCH');
        }
        const row = rows[scopeKey];
        return {
          snapshotAt: NOW,
          nextCursor: `${scopeKey}.next`,
          items: [{
            ...row,
            lifecycleStatus: 'active',
            lifecycleRevision: 2,
            onboardingState: 'complete',
            identityState: 'active',
            invitationId: null,
            invitationState: 'none',
            invitationRevision: null,
            invitationExpiresAt: null,
            updatedAt: NOW,
          }],
        };
      },
    },
  });
  const [scopeA, scopeB] = await Promise.all([
    service.listDirectory({ operatorContext: { scopeKey: 'scope-a' }, query: { limit: 1 } }),
    service.listDirectory({ operatorContext: { scopeKey: 'scope-b' }, query: { limit: 1 } }),
  ]);
  assert.deepEqual(scopeA.items.map((item) => item.tenantId), [TENANT_ID]);
  assert.deepEqual(scopeB.items.map((item) => item.tenantId), [OTHER_TENANT_ID]);
  assert.deepEqual(calls.map((call) => call.scopeKey).sort(), ['scope-a', 'scope-b']);
  await assert.rejects(service.listDirectory({
    operatorContext: { scopeKey: 'scope-b' },
    query: { limit: 1, cursor: scopeA.nextCursor },
  }), /CURSOR_SCOPE_MISMATCH/);
});

test('directory invitation identifiers and states must remain internally consistent', async () => {
  const { service } = fixtures({
    directoryReader: {
      async list() {
        return {
          snapshotAt: NOW,
          nextCursor: null,
          items: [{
            tenantId: TENANT_ID,
            displayName: 'Northwind',
            lifecycleStatus: 'onboarding',
            lifecycleRevision: 2,
            onboardingState: 'invited',
            identityState: 'pending',
            invitationId: null,
            invitationState: 'open',
            invitationRevision: 3,
            invitationExpiresAt: EXPIRES_AT,
            updatedAt: NOW,
          }],
        };
      },
    },
  });
  await assert.rejects(
    service.listDirectory({ operatorContext: {}, query: {} }),
    /PLATFORM_TENANT_RESULT_INVALID/,
  );
});

test('pending Tenant creation returns its purpose-bound invitation once and exact replay is secret-free', async () => {
  const { service, state } = fixtures();
  const input = {
    operatorContext: {},
    displayName: 'Northwind',
    reason: 'Approved onboarding request.',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Northwind' },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  const first = await service.createTenantInvitation(input);
  assert.equal(first.tenant.status, 'pending');
  assert.deepEqual(first.oneTimeDelivery, { available: true, token: TOKEN, expiresAt: EXPIRES_AT });
  assert.equal(state.created.tokenHash, TOKEN_HASH);
  assert.equal(state.created.operation, PLATFORM_OPERATION.TENANT_INVITATION_CREATE);
  assert.equal(Object.hasOwn(state.created, 'token'), false);
  assert.equal(state.permissions[0], PLATFORM_PERMISSION.INVITATION_MANAGE);
  assert.equal(state.creationAuthorizations, 1);

  const replay = await service.createTenantInvitation(input);
  assert.equal(replay.outcome, 'idempotent');
  assert.deepEqual(replay.oneTimeDelivery, { available: false });
  assert.doesNotMatch(JSON.stringify(replay), new RegExp(TOKEN));
  assert.equal(state.idCalls, 2, 'replay must not allocate a second Tenant or invitation ID');
  assert.equal(state.secretCalls, 1, 'replay must not mint a second secret');
  assert.equal(state.invitationWrites, 1);

  await assert.rejects(service.createTenantInvitation({
    ...input,
    displayName: 'Contoso',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Contoso' },
  }), (error) => error.code === 'PLATFORM_IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(state.idCalls, 2);
});

test('concurrent exact Tenant creation retries return the winner receipt and never expose the loser secret', async () => {
  const identifiers = [TENANT_ID, INVITATION_ID, OTHER_TENANT_ID, NEW_INVITATION_ID];
  let entered = 0;
  let releaseSecond;
  const secondEntered = new Promise((resolve) => { releaseSecond = resolve; });
  let winner;
  let winnerCommitted;
  const committed = new Promise((resolve) => { winnerCommitted = resolve; });
  const { service } = fixtures({
    idFactory() { return identifiers.shift(); },
    operationReceiptReader: { async find() { return null; } },
    invitationTransactions: {
      async create(values) {
        entered += 1;
        if (entered === 1) {
          await secondEntered;
          winner = {
            tenant: {
              tenantId: values.tenantId,
              displayName: values.displayName,
              status: 'pending',
              revision: 1,
              createdAt: NOW,
            },
            invitation: {
              invitationId: values.invitationId,
              state: 'open',
              revision: 1,
              expiresAt: values.expiresAt,
            },
          };
          winnerCommitted();
          return { outcome: 'updated', ...winner };
        }
        releaseSecond();
        await committed;
        return { outcome: 'idempotent', ...winner };
      },
      async revoke() {},
      async reissue() {},
    },
  });
  const input = {
    operatorContext: {},
    displayName: 'Northwind',
    reason: 'Approved onboarding request.',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Northwind' },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  const results = await Promise.all([service.createTenantInvitation(input), service.createTenantInvitation(input)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['idempotent', 'updated']);
  assert.equal(results.filter((result) => result.oneTimeDelivery.available).length, 1);
  assert.equal(results.find((result) => result.outcome === 'idempotent').tenant.tenantId, TENANT_ID);
  assert.deepEqual(results.find((result) => result.outcome === 'idempotent').oneTimeDelivery, { available: false });
});

test('Tenant creation fails closed on generated identifier collisions without minting or persisting a secret', async () => {
  let writes = 0;
  let secretCalls = 0;
  const { service } = fixtures({
    idFactory: () => TENANT_ID,
    invitationSecretFactory: {
      async issue() { secretCalls += 1; return { token: TOKEN, tokenHash: TOKEN_HASH, expiresAt: EXPIRES_AT }; },
    },
    invitationTransactions: {
      async create() { writes += 1; },
      async revoke() {},
      async reissue() {},
    },
  });
  await assert.rejects(service.createTenantInvitation({
    operatorContext: {},
    displayName: 'Northwind',
    reason: 'Approved onboarding request.',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Northwind' },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  }), (error) => error.code === 'PLATFORM_IDENTIFIER_COLLISION');
  assert.equal(secretCalls, 0);
  assert.equal(writes, 0);
});

test('allowlist-scoped operators cannot create a Tenant before any identifier or secret is issued', async () => {
  let idCalls = 0;
  let secretCalls = 0;
  let writes = 0;
  const { service } = fixtures({
    tenantTargetPolicy: {
      async authorize() { return true; },
      async queryScope() { return { mode: 'allowlist', securityVersion: 1 }; },
      async authorizeCreation() {
        throw new PlatformAuthorizationError('PLATFORM_TENANT_CREATION_DENIED');
      },
    },
    idFactory() { idCalls += 1; return TENANT_ID; },
    invitationSecretFactory: {
      async issue() { secretCalls += 1; return { token: TOKEN, tokenHash: TOKEN_HASH, expiresAt: EXPIRES_AT }; },
    },
    invitationTransactions: {
      async create() { writes += 1; },
      async revoke() {},
      async reissue() {},
    },
  });
  await assert.rejects(service.createTenantInvitation({
    operatorContext: {},
    displayName: 'Northwind',
    reason: 'Approved onboarding request.',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Northwind' },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  }), (error) => error.code === 'PLATFORM_TENANT_CREATION_DENIED');
  assert.equal(idCalls, 0);
  assert.equal(secretCalls, 0);
  assert.equal(writes, 0);
});

test('Tenant creation exposes no secret when persistence reports an identifier collision', async () => {
  let transactionInput;
  const { service } = fixtures({
    invitationTransactions: {
      async create(values) { transactionInput = values; return { outcome: 'identifier_conflict' }; },
      async revoke() {},
      async reissue() {},
    },
  });
  await assert.rejects(service.createTenantInvitation({
    operatorContext: {},
    displayName: 'Northwind',
    reason: 'Approved onboarding request.',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE, displayName: 'Northwind' },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  }), (error) => error.code === 'PLATFORM_TENANT_IDENTIFIER_CONFLICT');
  assert.equal(transactionInput.tokenHash, TOKEN_HASH);
  assert.equal(Object.hasOwn(transactionInput, 'token'), false);
});

test('invitation reissue returns its token once and replay is stable but non-secret', async () => {
  const { service, state } = fixtures();
  const input = mutationInput(PLATFORM_OPERATION.INVITATION_REISSUE);
  const first = await service.reissueInvitation(input);
  assert.equal(first.outcome, 'updated');
  assert.deepEqual(first.oneTimeDelivery, { available: true, token: TOKEN, expiresAt: EXPIRES_AT });
  assert.equal(state.invitationReads, 1);
  assert.equal(state.invitationWrites, 1);
  assert.equal(state.reissued.newInvitationId, NEW_INVITATION_ID);
  assert.equal(state.reissued.tokenHash, TOKEN_HASH);
  assert.equal(Object.hasOwn(state.reissued, 'token'), false);

  const replay = await service.reissueInvitation(input);
  assert.equal(replay.outcome, 'idempotent');
  assert.deepEqual(replay.oneTimeDelivery, { available: false });
  assert.doesNotMatch(JSON.stringify(replay), new RegExp(TOKEN));
  assert.equal(state.invitationReads, 1, 'receipt lookup must occur before stale invitation state is read');
  assert.equal(state.invitationWrites, 1);

  await assert.rejects(
    service.reissueInvitation(mutationInput(PLATFORM_OPERATION.INVITATION_REISSUE, { reason: 'Different request.' })),
    (error) => error instanceof PlatformOperationConflictError && error.code === 'PLATFORM_IDEMPOTENCY_KEY_CONFLICT',
  );
});

test('invitation revocation records both audit domains through the atomic transaction contract', async () => {
  const { service, state } = fixtures();
  const result = await service.revokeInvitation(mutationInput(PLATFORM_OPERATION.INVITATION_REVOKE));
  assert.equal(result.invitation.state, 'revoked');
  assert.equal(state.evidence.operation, PLATFORM_OPERATION.INVITATION_REVOKE);
  assert.deepEqual(state.evidence.previousState, { state: 'open', revision: 3 });
  assert.equal(state.permissions.at(-1), PLATFORM_PERMISSION.INVITATION_MANAGE);
});

test('suspended to archived is terminal CAS and retries consult the receipt before current state', async () => {
  const { service, state } = fixtures();
  const input = {
    operatorContext: {},
    tenantId: TENANT_ID,
    targetStatus: 'archived',
    expectedRevision: 7,
    reason: 'Retention-approved tenant archive.',
    confirmation: { action: PLATFORM_OPERATION.LIFECYCLE_TRANSITION, tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  const first = await service.transitionLifecycle(input);
  assert.equal(first.lifecycle.status, 'archived');
  assert.equal(state.lifecycleChanged.operation, PLATFORM_OPERATION.LIFECYCLE_TRANSITION);
  assert.equal(state.policyTransition, undefined, 'archive extension must not duplicate the canonical transition matrix');

  const replay = await service.transitionLifecycle(input);
  assert.equal(replay.outcome, 'idempotent');
  assert.equal(replay.lifecycle.status, 'archived');
  assert.equal(state.lifecycleReads, 1);
  assert.equal(state.lifecycleWrites, 1);
});

test('archive is allowed only from suspended and all non-archive transitions use the canonical policy', async () => {
  const active = fixtures({
    lifecycleReader: { async findCurrent() { return { tenantId: TENANT_ID, status: 'active', revision: 7 }; } },
  });
  const archive = {
    operatorContext: {},
    tenantId: TENANT_ID,
    targetStatus: 'archived',
    expectedRevision: 7,
    reason: 'Archive request.',
    confirmation: { action: PLATFORM_OPERATION.LIFECYCLE_TRANSITION, tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  await assert.rejects(
    active.service.transitionLifecycle(archive),
    (error) => error.code === 'PLATFORM_LIFECYCLE_TRANSITION_DENIED',
  );

  const suspend = await active.service.transitionLifecycle({
    ...archive,
    targetStatus: 'suspended',
    reason: 'Suspend request.',
  });
  assert.equal(suspend.lifecycle.status, 'suspended');
  assert.deepEqual(active.state.policyTransition, { currentStatus: 'active', targetStatus: 'suspended' });
});

test('concurrent direct-Tenant requests cannot use a valid permission to cross the target allowlist', async () => {
  const { service, state } = fixtures({
    tenantTargetPolicy: {
      async authorize(_principal, tenantId) {
        await Promise.resolve();
        if (tenantId !== TENANT_ID) {
          throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
        }
        return true;
      },
      async queryScope() { return { mode: 'allowlist', securityVersion: 1, scopeKey: 'scope-a' }; },
      async authorizeCreation() { throw new PlatformAuthorizationError('PLATFORM_TENANT_CREATION_DENIED'); },
    },
  });
  const base = {
    operatorContext: {},
    targetStatus: 'archived',
    expectedRevision: 7,
    reason: 'Retention-approved archive.',
    correlationId: CORRELATION_ID,
  };
  const [allowed, denied] = await Promise.allSettled([
    service.transitionLifecycle({
      ...base,
      tenantId: TENANT_ID,
      confirmation: { action: PLATFORM_OPERATION.LIFECYCLE_TRANSITION, tenantId: TENANT_ID },
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    service.transitionLifecycle({
      ...base,
      tenantId: OTHER_TENANT_ID,
      confirmation: { action: PLATFORM_OPERATION.LIFECYCLE_TRANSITION, tenantId: OTHER_TENANT_ID },
      idempotencyKey: OTHER_IDEMPOTENCY_KEY,
    }),
  ]);
  assert.equal(allowed.status, 'fulfilled');
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.reason.code, 'PLATFORM_TENANT_TARGET_DENIED');
  assert.equal(state.lifecycleReads, 1, 'denied targets must never reach the lifecycle reader');
  assert.equal(state.lifecycleWrites, 1);
});
