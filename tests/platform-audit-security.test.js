import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  PLATFORM_AUDIT_RETENTION,
  canonicalPlatformAuditPayload,
  normalizePlatformAuditEvent,
} from '../src/platform/audit/event.js';
import { PlatformAuditInputError } from '../src/platform/audit/errors.js';
import { PlatformAuthorizationError } from '../src/platform/identity/errors.js';
import {
  PLATFORM_ROLE,
  createPlatformAuthorizationPolicy,
  permissionsForPlatformRoles,
} from '../src/platform/identity/policy.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const roles = [PLATFORM_ROLE.SECURITY_AUDITOR];
const targetScope = Object.freeze({ mode: 'all', operatorId: OPERATOR_ID, securityVersion: 1 });
const tenantTargetPolicy = Object.freeze({ async queryScope() { return targetScope; } });

function principal() {
  return {
    operatorId: OPERATOR_ID,
    providerIdentity: {
      provider: 'entra_platform',
      tenantReference: 'operator-tenant',
      subjectReference: 'operator-subject',
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,
    targetScope: { mode: 'all', securityVersion: 1 },
    assurance: {
      level: 'mfa',
      authenticationContext: 'cm-platform-mfa',
      authenticatedAt: '2026-08-28T11:55:00.000Z',
    },
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-28T11:55:00.000Z',
      expiresAt: '2026-08-28T15:55:00.000Z',
      securityVersion: 1,
      securityEpoch: 7,
      stepUpExpiresAt: null,
    },
  };
}

function event(overrides = {}) {
  return {
    operatorId: OPERATOR_ID,
    roles,
    permissions: permissionsForPlatformRoles(roles),
    assuranceLevel: 'mfa',
    targetTenantId: TENANT_ID,
    action: PLATFORM_AUDIT_ACTION.TENANT_LIFECYCLE_CHANGED,
    targetType: 'tenant',
    targetId: TENANT_ID,
    previousState: { status: 'ready' },
    newState: { status: 'active' },
    occurredAt: '2026-08-28T12:00:00.000Z',
    correlationId: CORRELATION_ID,
    outcome: PLATFORM_AUDIT_OUTCOME.SUCCESS,
    metadata: { reasonCode: 'activation_approved' },
    retentionClass: PLATFORM_AUDIT_RETENTION.ADMINISTRATIVE,
    ...overrides,
  };
}

test('Platform audit is a distinct canonical domain with sequence and Tenant target binding', () => {
  const normalized = normalizePlatformAuditEvent(event());
  assert.equal(normalized.targetTenantId, TENANT_ID);
  assert.notEqual(
    canonicalPlatformAuditPayload(normalized, { sequence: 1 }),
    canonicalPlatformAuditPayload(normalized, { sequence: 2 }),
  );
  assert.throws(() => normalizePlatformAuditEvent(event({ roles: ['tenant_admin'] })), PlatformAuditInputError);
  assert.throws(() => normalizePlatformAuditEvent(event({ operatorId: null })), PlatformAuditInputError);
});

test('recovery preview and execution have distinct truthful audit actions', () => {
  assert.equal(PLATFORM_AUDIT_ACTION.RECOVERY_PREVIEWED, 'platform.recovery.previewed');
  assert.equal(PLATFORM_AUDIT_ACTION.RECOVERY_EXECUTED, 'platform.recovery.executed');
  assert.equal(normalizePlatformAuditEvent(event({
    action: PLATFORM_AUDIT_ACTION.RECOVERY_PREVIEWED,
  })).action, PLATFORM_AUDIT_ACTION.RECOVERY_PREVIEWED);
});

test('Platform audit payload rejects secrets, subject references, nesting, and oversized values', () => {
  for (const metadata of [
    { accessToken: 'secret' },
    { sessionId: SESSION_ID },
    { subjectReference: 'provider-subject' },
    { nested: { value: true } },
    { note: 'x'.repeat(513) },
  ]) assert.throws(() => normalizePlatformAuditEvent(event({ metadata })), PlatformAuditInputError);
});

test('audit service refuses caller authority overrides and derives actor, outcome, and time', () => {
  const repository = { append() {}, listVerified() {} };
  const service = createPlatformAuditService({
    repository,
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy,
    clock: () => Date.parse('2026-08-28T12:00:00.000Z'),
    idFactory: () => CORRELATION_ID,
  });
  const intent = {
    principal: principal(),
    action: PLATFORM_AUDIT_ACTION.DIAGNOSTICS_READ,
    targetType: 'diagnostics',
    targetId: 'fleet',
  };
  const created = service.createEvent(intent);
  assert.equal(created.operatorId, OPERATOR_ID);
  assert.equal(created.outcome, PLATFORM_AUDIT_OUTCOME.SUCCESS);
  assert.equal(created.occurredAt, '2026-08-28T12:00:00.000Z');
  for (const forged of [
    { operatorId: null },
    { roles: [] },
    { permissions: [] },
    { assuranceLevel: 'break_glass' },
    { occurredAt: '2020-01-01T00:00:00.000Z' },
    { outcome: 'failure' },
  ]) assert.throws(() => service.createEvent({ ...intent, ...forged }), /PLATFORM_AUDIT_AUTHORITY_FIELDS_FORBIDDEN/);
  assert.throws(() => service.createUnmappedAuthenticationFailure({
    reasonCode: 'issuer_mismatch',
    operatorId: OPERATOR_ID,
  }), /PLATFORM_AUDIT_AUTHORITY_FIELDS_FORBIDDEN/);
});

test('audit query verifies before return, records the read, and strips integrity internals', async () => {
  const appended = [];
  const repository = {
    async append(value) { appended.push(value); },
    async listVerified() {
      return [{
        sequence: 9,
        ...event(),
        previousHash: 'a'.repeat(64),
        eventHash: 'b'.repeat(64),
        integrityVersion: 1,
      }];
    },
  };
  const service = createPlatformAuditService({
    repository,
    authorizationPolicy: { authorize() { return true; } },
    tenantTargetPolicy,
    clock: () => Date.parse('2026-08-28T12:00:00.000Z'),
  });
  const result = await service.list({ principal: principal(), correlationId: CORRELATION_ID });
  assert.equal(result.length, 1);
  assert.equal(result[0].eventHash, undefined);
  assert.equal(result[0].previousHash, undefined);
  assert.equal(result[0].integrityVersion, undefined);
  assert.equal(appended[0].action, PLATFORM_AUDIT_ACTION.AUDIT_READ);
});

test('bounded audit export has an independent permission and fresh step-up requirement', async () => {
  const appended = [];
  const repository = {
    async append(value) { appended.push(value); },
    async listVerified({ limit }) {
      assert.equal(limit, 100);
      return [];
    },
  };
  const service = createPlatformAuditService({
    repository,
    authorizationPolicy: createPlatformAuthorizationPolicy({
      clock: () => Date.parse('2026-08-28T12:00:00.000Z'),
    }),
    tenantTargetPolicy,
    clock: () => Date.parse('2026-08-28T12:00:00.000Z'),
  });
  await assert.rejects(service.export({ principal: principal() }), /PLATFORM_STEP_UP_REQUIRED/);
  const elevated = {
    ...principal(),
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt: '2026-08-28T11:58:00.000Z',
    },
    session: {
      ...principal().session,
      issuedAt: '2026-08-28T12:00:00.000Z',
      stepUpExpiresAt: '2026-08-28T12:03:00.000Z',
    },
  };
  assert.deepEqual(await service.export({ principal: elevated }), []);
  assert.equal(appended[0].action, PLATFORM_AUDIT_ACTION.AUDIT_EXPORTED);
});

test('audit list and export await async authorization and never query on denial', async () => {
  let queries = 0;
  const repository = {
    async append() { throw new Error('AUDIT_APPEND_MUST_NOT_RUN'); },
    async listVerified() { queries += 1; return []; },
  };
  const denied = createPlatformAuditService({
    repository,
    authorizationPolicy: {
      async authorize() {
        await Promise.resolve();
        throw new PlatformAuthorizationError();
      },
    },
    tenantTargetPolicy,
  });
  await assert.rejects(denied.list({ principal: principal() }), PlatformAuthorizationError);
  const elevated = {
    ...principal(),
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt: '2026-08-28T11:58:00.000Z',
    },
    session: {
      ...principal().session,
      issuedAt: '2026-08-28T12:00:00.000Z',
      stepUpExpiresAt: '2026-08-28T12:03:00.000Z',
    },
  };
  await assert.rejects(denied.export({ principal: elevated }), PlatformAuthorizationError);
  assert.equal(queries, 0);

  const falseDecision = createPlatformAuditService({
    repository,
    authorizationPolicy: { async authorize() { return false; } },
    tenantTargetPolicy,
  });
  await assert.rejects(falseDecision.list({ principal: principal() }), PlatformAuthorizationError);
  assert.equal(queries, 0);
});
