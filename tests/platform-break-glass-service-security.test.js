import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_OUTCOME } from '../src/platform/audit/event.js';
import { createPlatformBreakGlassService } from '../src/platform/identity/break-glass-service.js';
import { createPlatformBreakGlassAuthorizationContext } from '../src/platform/identity/break-glass.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import {
  PLATFORM_PERMISSION,
  PLATFORM_ROLE,
  createPlatformAuthorizationPolicy,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function principal(operatorId, sessionId, securityVersion) {
  const roles = [PLATFORM_ROLE.SECURITY_ADMIN];
  return {
    operatorId,
    providerIdentity: {
      provider: 'microsoft_entra_platform',
      tenantReference: 'operator-tenant',
      subjectReference: operatorId,
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion,
    targetScope: { mode: 'all', securityVersion },
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt: '2026-08-28T11:59:00.000Z',
    },
    session: {
      id: sessionId,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z',
      securityVersion,
      securityEpoch: 7,
      stepUpExpiresAt: '2026-08-28T12:04:00.000Z',
    },
  };
}

function storedGrant(record) {
  return Object.freeze({
    id: record.id,
    operatorId: record.operatorId,
    approverOperatorId: record.approverOperatorId,
    targetTenantId: record.targetTenantId,
    permission: record.permission,
    reason: record.reason,
    approvalReference: record.approvalReference,
    issuedAt: '2026-08-28T12:01:00.000Z',
    expiresAt: '2026-08-28T12:11:00.000Z',
    consumedAt: null,
  });
}

function harness({ denyConsumption = false } = {}) {
  const state = { events: [], mutationCalls: 0, records: [] };
  const auditService = createPlatformAuditService({
    repository: { append() {}, listVerified() {} },
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy: { async queryScope() { return {}; } },
    clock: () => Date.parse('2026-08-28T12:01:00.000Z'),
  });
  let grant;
  const repository = {
    async issue(record, eventFactory) {
      state.records.push(record);
      grant = storedGrant(record);
      state.events.push(eventFactory(grant));
      return grant;
    },
    async revoke(record, eventFactory) {
      state.records.push(record);
      state.events.push(eventFactory(grant));
      return grant;
    },
    async executeAuthorizedMutation({ consumption, eventFactory, deniedEventFactory, mutation }) {
      state.records.push(consumption);
      if (denyConsumption) {
        state.events.push(deniedEventFactory());
        return null;
      }
      const consumed = Object.freeze({ ...grant, consumedAt: '2026-08-28T12:02:00.000Z' });
      const authorization = createPlatformBreakGlassAuthorizationContext(consumed);
      const result = await mutation(Object.freeze({ client: { transaction: true }, authorization }));
      state.mutationCalls += 1;
      state.events.push(eventFactory(consumed));
      return Object.freeze({ executed: true, result });
    },
  };
  const service = createPlatformBreakGlassService({
    repository,
    authorizationPolicy: createPlatformAuthorizationPolicy({
      clock: () => Date.parse('2026-08-28T12:01:00.000Z'),
    }),
    tenantTargetPolicy: { async authorize() { return true; } },
    auditService,
    tokenFactory: () => TOKEN,
    idFactory: () => GRANT_ID,
  });
  return { service, state };
}

function request() {
  return {
    principal: principal(OPERATOR_ID, '66666666-6666-4666-8666-666666666666', 3),
    approverPrincipal: principal(APPROVER_ID, '77777777-7777-4777-8777-777777777777', 5),
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    reason: 'Restore authoritative tenant administration access',
    approvalReference: 'INC-2026-0042',
    ttlSeconds: 600,
    correlationId: CORRELATION_ID,
  };
}

test('break-glass issue and consume require two step-up actors and bind audit to the protected mutation', async () => {
  const { service, state } = harness();
  const issued = await service.issue(request());
  assert.equal(issued.token, TOKEN);
  assert.equal(state.records[0].operatorSecurityVersion, 3);
  assert.equal(state.records[0].approverSecurityVersion, 5);
  assert.equal(state.events[0].action, PLATFORM_AUDIT_ACTION.BREAK_GLASS_GRANTED);
  assert.equal(state.events[0].assuranceLevel, 'step_up');

  const result = await service.execute({
    principal: request().principal,
    token: TOKEN,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    correlationId: CORRELATION_ID,
    async mutation({ client, authorization }) {
      assert.equal(client.transaction, true);
      assert.equal(authorization.grantId, GRANT_ID);
      return { repaired: true };
    },
  });
  assert.deepEqual(result, { repaired: true });
  assert.equal(state.mutationCalls, 1);
  assert.equal(state.events[1].action, PLATFORM_AUDIT_ACTION.BREAK_GLASS_USED);
  assert.equal(state.events[1].assuranceLevel, 'break_glass');
});

test('invalid grant consumption records a narrow denial and never invokes mutation', async () => {
  const { service, state } = harness({ denyConsumption: true });
  await service.issue(request());
  await assert.rejects(service.execute({
    principal: request().principal,
    token: TOKEN,
    targetTenantId: TENANT_ID,
    permission: PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    correlationId: CORRELATION_ID,
    async mutation() { throw new Error('MUST_NOT_RUN'); },
  }), PlatformAuthorizationError);
  assert.equal(state.mutationCalls, 0);
  const denial = state.events.at(-1);
  assert.equal(denial.action, PLATFORM_AUDIT_ACTION.BREAK_GLASS_DENIED);
  assert.equal(denial.outcome, PLATFORM_AUDIT_OUTCOME.DENIED);
  assert.deepEqual(denial.metadata, { reasonCode: 'grant_rejected' });
});

test('break-glass self-approval is rejected before persistence', async () => {
  const { service, state } = harness();
  await assert.rejects(service.issue({
    ...request(),
    approverPrincipal: request().principal,
  }), /PLATFORM_BREAK_GLASS_DUAL_CONTROL_REQUIRED/);
  assert.equal(state.records.length, 0);
});
