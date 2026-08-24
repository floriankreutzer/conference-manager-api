import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
  canonicalAuditPayload,
  normalizeAuditEvent,
} from '../src/audit/event.js';
import { AuditInputError, AuditIntegrityError } from '../src/audit/errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777';

function event(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    actorUserId: USER_ID,
    action: AUDIT_ACTION.REQUEST_TRANSITION,
    targetType: 'request',
    targetId: 'REQ-1',
    previousState: { status: 'Submitted' },
    newState: { status: 'Confirmed' },
    occurredAt: '2026-08-24T09:00:00.000Z',
    correlationId: CORRELATION_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { reasonProvided: false, transition: 'confirm' },
    retentionClass: AUDIT_RETENTION_CLASS.BUSINESS,
    ...overrides,
  };
}

function principal({
  roles = [TENANT_ROLE.TENANT_ADMIN],
  permissions = [PERMISSION.TENANT_AUDIT_READ],
} = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles,
    permissions,
  };
}

test('audit events are normalized, bounded, and canonical regardless of safe-object key order', () => {
  const first = normalizeAuditEvent(event({ metadata: { transition: 'confirm', reasonProvided: false } }));
  const second = normalizeAuditEvent(event({ metadata: { reasonProvided: false, transition: 'confirm' } }));
  assert.deepEqual(first.metadata, second.metadata);
  assert.equal(canonicalAuditPayload(first), canonicalAuditPayload(second));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.metadata));
});

test('audit events reject secret-bearing keys, nested payloads, invalid actors, and oversized metadata', () => {
  for (const metadata of [
    { accessToken: 'secret-value' },
    { csrfToken: 'secret-value' },
    { sessionId: '55555555-5555-4555-8555-555555555555' },
    { clientSecret: 'secret-value' },
    { nested: { value: 'not-allowed' } },
  ]) {
    assert.throws(() => normalizeAuditEvent(event({ metadata })), AuditInputError);
  }
  assert.throws(
    () => normalizeAuditEvent(event({ actorUserId: 'browser-user' })),
    AuditInputError,
  );
  assert.throws(
    () => normalizeAuditEvent(event({ metadata: { note: 'x'.repeat(4097) } })),
    AuditInputError,
  );
});

test('tenant audit read requires tenant-admin role plus explicit permission and audits denied access', async () => {
  const authorizationPolicy = createAuthorizationPolicy();
  const harness = createAuditHarness({ authorizationPolicy });
  await harness.service.record({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
    targetType: 'tenant',
    targetId: TENANT_ID,
    outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { changedFieldCount: 1 },
    retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
  });

  const events = await harness.service.listTenantEvents({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID },
    limit: 10,
    correlationId: CORRELATION_ID,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED);
  assert.equal(harness.events.at(-1).action, AUDIT_ACTION.AUDIT_READ);

  const employee = principal({
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ],
  });
  await assert.rejects(
    harness.service.listTenantEvents({
      principal: employee,
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(harness.events.at(-1).action, AUDIT_ACTION.AUTHORIZATION_DENIED);
  assert.equal(harness.events.at(-1).outcome, AUDIT_OUTCOME.DENIED);
});

test('tenant audit read fails closed on integrity failure and invalid pagination', async () => {
  const compromised = createAuditHarness({ verifyResult: false });
  await assert.rejects(
    compromised.service.listTenantEvents({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
    }),
    AuditIntegrityError,
  );
  assert.equal(compromised.events.length, 0);

  const valid = createAuditHarness();
  for (const values of [
    { limit: 0 },
    { limit: 101 },
    { beforeId: '0' },
    { beforeId: 'not-a-cursor' },
  ]) {
    await assert.rejects(
      valid.service.listTenantEvents({
        principal: principal(),
        tenantContext: { tenantId: TENANT_ID },
        correlationId: CORRELATION_ID,
        ...values,
      }),
      AuditInputError,
    );
  }
});
