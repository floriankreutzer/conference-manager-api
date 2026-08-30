import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { PLATFORM_AUDIT_ACTION } from '../src/platform/audit/event.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import { createPlatformOperatorLifecycleService } from '../src/platform/identity/operator-lifecycle-service.js';
import {
  PLATFORM_ROLE,
  createPlatformAuthorizationPolicy,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const WORKFORCE_TENANT_ID = '66666666-6666-4666-8666-666666666666';
const WORKFORCE_SUBJECT_ID = '77777777-7777-4777-8777-777777777777';
const roles = [PLATFORM_ROLE.SECURITY_ADMIN];

function principal(operatorId, sessionId) {
  return {
    operatorId,
    providerIdentity: {
      provider: 'microsoft_entra_platform',
      tenantReference: WORKFORCE_TENANT_ID,
      subjectReference: operatorId,
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 3,
    targetScope: { mode: 'all', securityVersion: 3 },
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt: '2026-08-28T11:59:00.000Z',
    },
    session: {
      id: sessionId,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: '2026-08-28T16:00:00.000Z',
      securityVersion: 3,
      securityEpoch: 7,
      stepUpExpiresAt: '2026-08-28T12:04:00.000Z',
    },
  };
}

function operator(overrides = {}) {
  return Object.freeze({
    id: TARGET_ID,
    status: 'active',
    roles: Object.freeze([PLATFORM_ROLE.SUPPORT_READER]),
    securityVersion: 1,
    scopeMode: 'allowlist',
    tenantIds: Object.freeze([TENANT_ID]),
    providerIdentity: Object.freeze({
      provider: 'microsoft_entra_platform',
      tenantReference: WORKFORCE_TENANT_ID,
      subjectReference: WORKFORCE_SUBJECT_ID,
    }),
    ...overrides,
  });
}

function harness({ authorize = () => true } = {}) {
  const calls = [];
  const auditService = createPlatformAuditService({
    repository: { append() {}, listVerified() {} },
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy: { async queryScope() { return { mode: 'all', operatorId: ACTOR_ID, securityVersion: 3 }; } },
    clock: () => Date.parse('2026-08-28T12:01:00.000Z'),
  });
  const repository = {
    async createApproved(record, events) {
      const result = Object.freeze({
        action: 'created', operator: operator(), previous: null,
        sessionsRevoked: 0, transactionsRevoked: 0, grantsRevoked: 0,
      });
      calls.push({ method: 'create', record, events: events(result) });
      return result;
    },
    async changeAccessApproved(record, events) {
      const result = Object.freeze({
        action: 'access_changed',
        operator: operator({
          roles: record.roles,
          securityVersion: record.expectedSecurityVersion + 1,
          scopeMode: record.scopeMode,
          tenantIds: record.tenantIds,
        }),
        previous: operator({ securityVersion: record.expectedSecurityVersion }),
        sessionsRevoked: 2,
        transactionsRevoked: 1,
        grantsRevoked: 1,
      });
      calls.push({ method: 'change', record, events: events(result) });
      return result;
    },
    async disableApproved(record, events) {
      const result = Object.freeze({
        action: 'disabled',
        operator: operator({ status: 'disabled', securityVersion: record.expectedSecurityVersion + 1 }),
        previous: operator({ securityVersion: record.expectedSecurityVersion }),
        sessionsRevoked: 1,
        transactionsRevoked: 0,
        grantsRevoked: 1,
      });
      calls.push({ method: 'disable', record, events: events(result) });
      return result;
    },
  };
  const service = createPlatformOperatorLifecycleService({
    repository,
    authorizationPolicy: {
      async authorize(...values) { return authorize(...values); },
    },
    tenantTargetPolicy: {
      async authorize() { return true; },
      async queryScope(candidate) {
        return { mode: candidate.targetScope.mode, operatorId: candidate.operatorId, securityVersion: 3 };
      },
    },
    auditService,
    idFactory: () => TARGET_ID,
  });
  return { service, calls };
}

function approval() {
  return {
    principal: principal(ACTOR_ID, '88888888-8888-4888-8888-888888888888'),
    approverPrincipal: principal(APPROVER_ID, '99999999-9999-4999-8999-999999999999'),
    approvalReference: 'JML-2026-0042',
    reasonCode: 'approved_access_change',
    correlationId: CORRELATION_ID,
  };
}

test('operator joiner, mover, and leaver require independent step-up approval and emit two audit events', async () => {
  const { service, calls } = harness({
    authorize: createPlatformAuthorizationPolicy({
      clock: () => Date.parse('2026-08-28T12:01:00.000Z'),
    }).authorize,
  });
  await service.create({
    ...approval(),
    providerIdentity: {
      tenantReference: WORKFORCE_TENANT_ID.toUpperCase(),
      subjectReference: WORKFORCE_SUBJECT_ID.toUpperCase(),
    },
    roles: [PLATFORM_ROLE.SUPPORT_READER],
    scopeMode: 'allowlist',
    tenantIds: [TENANT_ID],
  });
  await service.changeAccess({
    ...approval(),
    operatorId: TARGET_ID,
    expectedSecurityVersion: 1,
    roles: [PLATFORM_ROLE.SECURITY_AUDITOR],
    scopeMode: 'allowlist',
    tenantIds: [TENANT_ID],
  });
  await service.disable({
    ...approval(),
    operatorId: TARGET_ID,
    expectedSecurityVersion: 2,
  });
  assert.deepEqual(calls.map((entry) => entry.method), ['create', 'change', 'disable']);
  for (const call of calls) {
    assert.deepEqual(call.events.map((event) => event.operatorId).sort(), [ACTOR_ID, APPROVER_ID]);
    assert.ok(call.events.every((event) => event.action === PLATFORM_AUDIT_ACTION.OPERATOR_CHANGED));
    assert.ok(call.events.every((event) => event.assuranceLevel === 'step_up'));
  }
  assert.equal(calls[0].record.providerIdentity.tenantReference, WORKFORCE_TENANT_ID);
  assert.equal(calls[1].events[0].metadata.sessionsRevoked, 2);
  assert.equal(calls[2].events[0].newState.status, 'disabled');
});

test('operator lifecycle rejects self-approval and awaits asynchronous authorization denial', async () => {
  const self = harness();
  await assert.rejects(self.service.disable({
    ...approval(),
    approverPrincipal: approval().principal,
    operatorId: TARGET_ID,
    expectedSecurityVersion: 1,
  }), /PLATFORM_OPERATOR_INDEPENDENT_APPROVAL_REQUIRED/);
  assert.equal(self.calls.length, 0);

  const denied = harness({ authorize: async () => {
    await Promise.resolve();
    throw new PlatformAuthorizationError();
  } });
  await assert.rejects(denied.service.disable({
    ...approval(),
    operatorId: TARGET_ID,
    expectedSecurityVersion: 1,
  }), PlatformAuthorizationError);
  assert.equal(denied.calls.length, 0);
});
