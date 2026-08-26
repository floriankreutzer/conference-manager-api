import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantAdminRecoveryService } from '../src/application/tenant-admin-recovery-service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_USER_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_USER_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';
const NOW = Date.parse('2026-08-26T09:00:00.000Z');
const OPERATOR = Object.freeze({ source: 'test_operator' });

function user({
  tenantId = TENANT_ID,
  userId = TARGET_USER_ID,
  active = true,
  elevatedRoles = [],
} = {}) {
  return Object.freeze({ tenantId, userId, active, elevatedRoles: Object.freeze([...elevatedRoles]) });
}

function fixture({ users, authorized = true } = {}) {
  const observed = { list: [], set: [] };
  const rows = users ?? [user({ elevatedRoles: ['conference_manager'] })];
  const service = createTenantAdminRecoveryService({
    repository: {
      async listByTenantId(values) {
        observed.list.push(values);
        return rows.filter((entry) => entry.tenantId === values.tenantId);
      },
      async setElevatedRoles(values) {
        observed.set.push(values);
        const previous = rows.find((entry) => (
          entry.tenantId === values.tenantId && entry.userId === values.targetUserId
        ));
        const auditEvent = values.auditEventFor({
          previousElevatedRoles: previous?.elevatedRoles ?? [],
          nextElevatedRoles: values.elevatedRoles,
        });
        return Object.freeze({
          status: 'updated',
          user: user({
            tenantId: values.tenantId,
            userId: values.targetUserId,
            elevatedRoles: values.elevatedRoles,
          }),
          auditEvent,
        });
      },
    },
    auditService: {
      createActorEvent(event) { return Object.freeze(event); },
    },
    authorizeOperator: async (context) => authorized && context === OPERATOR,
    clock: () => NOW,
  });
  return { service, observed };
}

test('recovery preserves existing elevated roles and adds Tenant Admin with audit evidence', async () => {
  const { service, observed } = fixture();
  const result = await service.recoverTenantAdmin({
    operatorContext: OPERATOR,
    tenantId: TENANT_ID,
    targetUserId: TARGET_USER_ID,
    correlationId: CORRELATION_ID,
  });

  assert.deepEqual(result.elevatedRoles, ['conference_manager', 'tenant_admin']);
  assert.equal(observed.set.length, 1);
  const audit = observed.set[0].auditEventFor({
    previousElevatedRoles: ['conference_manager'],
    nextElevatedRoles: ['conference_manager', 'tenant_admin'],
  });
  assert.equal(audit.action, 'tenant.user_permissions.changed');
  assert.equal(audit.actorUserId, null);
  assert.deepEqual(audit.metadata, {
    actorType: 'platform_operator',
    operation: 'tenant_admin_recovery',
  });
  assert.equal(audit.retentionClass, 'security');
});

test('operator authorization is deny-by-default', async () => {
  const { service, observed } = fixture({ authorized: false });
  await assert.rejects(
    service.recoverTenantAdmin({
      operatorContext: OPERATOR,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      correlationId: CORRELATION_ID,
    }),
    /OPERATOR_NOT_AUTHORIZED/,
  );
  assert.equal(observed.set.length, 0);
});

test('recovery refuses inactive, missing, or foreign-Tenant targets', async () => {
  for (const users of [
    [user({ active: false })],
    [],
    [user({ tenantId: OTHER_TENANT_ID })],
  ]) {
    const { service, observed } = fixture({ users });
    await assert.rejects(
      service.recoverTenantAdmin({
        operatorContext: OPERATOR,
        tenantId: TENANT_ID,
        targetUserId: TARGET_USER_ID,
        correlationId: CORRELATION_ID,
      }),
      /RECOVERY_TARGET_INVALID/,
    );
    assert.equal(observed.set.length, 0);
  }
});

test('recovery refuses when an active viable Tenant Admin already exists', async () => {
  const { service, observed } = fixture({
    users: [
      user({ elevatedRoles: ['conference_manager'] }),
      user({ userId: ADMIN_USER_ID, elevatedRoles: ['tenant_admin'] }),
    ],
  });
  await assert.rejects(
    service.recoverTenantAdmin({
      operatorContext: OPERATOR,
      tenantId: TENANT_ID,
      targetUserId: TARGET_USER_ID,
      correlationId: CORRELATION_ID,
    }),
    /RECOVERY_NOT_REQUIRED/,
  );
  assert.equal(observed.set.length, 0);
});

test('recovery queries and mutates only the requested Tenant and target user', async () => {
  const { service, observed } = fixture();
  await service.recoverTenantAdmin({
    operatorContext: OPERATOR,
    tenantId: TENANT_ID,
    targetUserId: TARGET_USER_ID,
    correlationId: CORRELATION_ID,
  });
  assert.equal(observed.list[0].tenantId, TENANT_ID);
  assert.equal(observed.set[0].tenantId, TENANT_ID);
  assert.equal(observed.set[0].targetUserId, TARGET_USER_ID);
});
