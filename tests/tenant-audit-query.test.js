import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { AuditInputError, AuditIntegrityError } from '../src/audit/errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import {
  createPostgresTenantAuditQueryRepository,
} from '../src/persistence/postgres/tenant-audit-query-repository.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function principal(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ['tenant_admin'],
    permissions: ['tenant:audit:read'],
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: '42',
    tenantId: TENANT_ID,
    actorUserId: USER_ID,
    action: 'integration.connected',
    targetType: 'integration',
    targetId: '44444444-4444-4444-8444-444444444444',
    previousState: { provider: 'microsoft365', status: 'pending', secret: 'must-not-pass' },
    newState: { provider: 'microsoft365', status: 'connected' },
    occurredAt: '2026-08-27T10:00:00.000Z',
    correlationId: CORRELATION_ID,
    outcome: 'success',
    metadata: { providerTenantReference: 'must-not-pass', reasonCode: 'internal' },
    retentionClass: 'administrative',
    previousHash: 'must-not-pass',
    eventHash: 'must-not-pass',
    ...overrides,
  };
}

function service({ rows = [row()], verify = true } = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  let received;
  return {
    audit,
    received: () => received,
    service: createTenantAuditQueryService({
      queryRepository: {
        async listByTenantId(values) {
          received = values;
          return rows;
        },
      },
      integrityRepository: {
        async verifyTenantChain(tenantId) {
          assert.equal(tenantId, TENANT_ID);
          return verify;
        },
      },
      authorizationPolicy,
      auditService: audit.service,
      clock: () => NOW,
    }),
  };
}

test('PostgreSQL audit query preserves metadata for the public allowlist projection', async () => {
  let statement;
  const repository = createPostgresTenantAuditQueryRepository({
    async query(value) {
      statement = value;
      return {
        rows: [{
          id: 42,
          tenant_id: TENANT_ID,
          actor_user_id: USER_ID,
          action: 'tenant.configuration.changed',
          target_type: 'catalogue',
          target_id: 'tenant-catalogue',
          previous_state: { revision: 3 },
          new_state: { revision: 4 },
          occurred_at: new Date('2026-08-27T10:00:00.000Z'),
          correlation_id: CORRELATION_ID,
          outcome: 'success',
          metadata: { operation: 'update', serviceCount: 4 },
        }],
      };
    },
  });

  const rows = await repository.listByTenantId({
    tenantId: TENANT_ID,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-27T12:00:00.000Z',
  });

  assert.equal(statement.name, 'tenant-audit-bounded-query');
  assert.match(statement.text, /\boutcome,\s+metadata\b/);
  assert.deepEqual(rows[0].metadata, { operation: 'update', serviceCount: 4 });
});

test('bounded Tenant audit filters reuse complete-chain verification and return a redacted projection', async () => {
  const harness = service({ rows: [row(), row({ id: '41' })] });
  const page = await harness.service.listEvents({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    limit: 1,
    category: 'integration',
    outcome: 'success',
    actorUserId: USER_ID,
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-27T12:00:00.000Z',
  });
  assert.equal(harness.received().tenantId, TENANT_ID);
  assert.equal(harness.received().limit, 2);
  assert.equal(harness.received().categoryActions.includes('integration.connected'), true);
  assert.equal(page.events.length, 1);
  assert.equal(page.nextBeforeId, '42');
  assert.deepEqual(page.events[0].target, { type: 'integration', id: null });
  assert.deepEqual(page.events[0].change, {
    before: { provider: 'microsoft365', status: 'pending' },
    after: { provider: 'microsoft365', status: 'connected' },
  });
  assert.equal(Object.hasOwn(page.events[0], 'metadata'), false);
  assert.equal(Object.hasOwn(page.events[0], 'eventHash'), false);
  assert.equal(Object.hasOwn(page.events[0], 'tenantId'), false);
  assert.equal(harness.audit.events.at(-1).action, 'audit.read');
});

test('configuration history projects revisions and only allowlisted metadata summaries', async () => {
  const harness = service({
    rows: [row({
      action: 'tenant.configuration.changed',
      targetType: 'catalogue',
      targetId: 'tenant-catalogue',
      previousState: { revision: 3 },
      newState: { revision: 4 },
      metadata: {
        activeServiceCount: 3,
        serviceCount: 4,
        operation: 'update',
        providerTenantReference: 'must-not-pass',
      },
    })],
  });
  const page = await harness.service.listEvents({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(page.events[0].change, {
    before: { revision: 3 },
    after: { revision: 4 },
    summary: { activeServiceCount: 3, serviceCount: 4 },
  });
});

test('audit query defaults to a bounded window and validates cursor/filter/window input', async () => {
  const harness = service({ rows: [] });
  const page = await harness.service.listEvents({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(page.window, {
    from: '2026-07-28T12:00:00.000Z',
    to: '2026-08-27T12:00:00.000Z',
  });

  for (const values of [
    { limit: 0 },
    { beforeId: '0' },
    { category: 'platform' },
    { outcome: 'unknown' },
    { actorUserId: 'not-a-uuid' },
    { from: '2026-01-01T00:00:00.000Z', to: '2026-08-27T12:00:00.000Z' },
    { from: '2026-08-27T13:00:00.000Z', to: '2026-08-27T12:00:00.000Z' },
  ]) {
    await assert.rejects(
      harness.service.listEvents({
        principal: principal(),
        tenantContext: { tenantId: TENANT_ID, status: 'active' },
        correlationId: CORRELATION_ID,
        ...values,
      }),
      AuditInputError,
    );
  }
});

test('audit query fails closed for integrity failure, cross-Tenant rows and missing permission', async () => {
  const compromised = service({ verify: false });
  await assert.rejects(
    compromised.service.listEvents({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuditIntegrityError,
  );

  const crossTenant = service({
    rows: [row({ tenantId: '99999999-9999-4999-8999-999999999999' })],
  });
  await assert.rejects(
    crossTenant.service.listEvents({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuditIntegrityError,
  );

  const malformedPersistedTime = service({ rows: [row({ occurredAt: 'not-an-instant' })] });
  await assert.rejects(
    malformedPersistedTime.service.listEvents({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuditIntegrityError,
  );

  const denied = service();
  await assert.rejects(
    denied.service.listEvents({
      principal: principal({ roles: ['employee'], permissions: ['request:read'] }),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(denied.audit.events.at(-1).action, 'authorization.denied');
});
