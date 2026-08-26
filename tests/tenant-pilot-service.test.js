import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantPilotService } from '../src/application/tenant-pilot-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444';

function principal(roles) {
  const snapshot = tenantAuthorizationSnapshot(roles);
  return Object.freeze({
    tenantId: TENANT_ID,
    userId: USER_ID,
    roles: snapshot.roles,
    permissions: snapshot.permissions,
  });
}

function fixtures(overrides = {}) {
  const entitlements = new Map([
    ['microsoft.directory', { enabled: true }],
    ['microsoft.calendar', { enabled: true }],
  ]);
  const tenant = { id: TENANT_ID, status: 'onboarding' };
  const repositories = {
    tenantRepository: {
      async findById() { return tenant; },
      async changeStatus(values) { return { ...tenant, status: values.targetStatus, auditEvent: values.auditEvent }; },
      async changeStatusIfReady(values) {
        return { outcome: 'updated', tenant: { ...tenant, status: values.targetStatus, auditEvent: values.auditEvent } };
      },
    },
    bindingRepository: {
      async findActiveBindingByTenantId() { return { status: 'active' }; },
    },
    connectionRepository: {
      async findByTenantId() {
        return {
          integrationId: INTEGRATION_ID,
          status: 'connected',
          placesPermission: 'granted',
          calendarsPermission: 'granted',
        };
      },
    },
    roomMappingRepository: {
      async listByTenantIdAndIntegrationId() { return [{ providerStatus: 'active' }]; },
    },
    capabilityHealthRepository: {
      async listByTenantIdAndIntegrationId() {
        return [{ capability: 'free_busy', status: 'healthy', lastSuccessAt: '2026-08-25T12:00:00.000Z' }];
      },
    },
    entitlementRepository: {
      async findByTenantIdAndCapabilityId(_tenantId, capabilityId) {
        return entitlements.get(capabilityId) || null;
      },
    },
  };
  return { entitlements, tenant, repositories: { ...repositories, ...overrides } };
}

function lifecycleRepository(status, { changeStatus } = {}) {
  const tenant = Object.freeze({ id: TENANT_ID, status });
  return {
    async findById() { return tenant; },
    async changeStatus(values) {
      if (changeStatus) return changeStatus(values);
      return { ...tenant, status: values.targetStatus, auditEvent: values.auditEvent };
    },
    async changeStatusIfReady(values) {
      const changed = changeStatus
        ? await changeStatus(values)
        : { ...tenant, status: values.targetStatus, auditEvent: values.auditEvent };
      return changed ? { outcome: 'updated', tenant: changed } : { outcome: 'stale' };
    },
  };
}

function service(options = {}) {
  const { repositories, ...state } = fixtures(options.repositories);
  return {
    state,
    service: createTenantPilotService({
      ...repositories,
      authorizationPolicy: createAuthorizationPolicy(),
      auditService: {
        createActorEvent(event) { return Object.freeze(event); },
      },
      authorizeOperator: options.authorizeOperator,
      clock: () => Date.parse('2026-08-25T12:00:00.000Z'),
    }),
  };
}

test('Tenant Admin readiness is server-derived and calendar write remains optional', async () => {
  const { service: pilot } = service();
  const result = await pilot.getReadiness({
    principal: principal(['tenant_admin']),
    tenantContext: { tenantId: TENANT_ID, status: 'onboarding' },
  });
  assert.equal(result.ready, true);
  assert.equal(result.entitlements.microsoftCalendarWrite, false);
  assert.deepEqual(Object.keys(result.checks).sort(), [
    'calendarEntitled',
    'calendarPermissionGranted',
    'directoryEntitled',
    'freeBusyVerified',
    'microsoft365Connected',
    'placesPermissionGranted',
    'roomImported',
    'tenantIdentityClaimed',
  ].sort());
});

test('Employee cannot read Tenant pilot or commercial entitlement diagnostics', async () => {
  const { service: pilot } = service();
  await assert.rejects(
    pilot.getReadiness({
      principal: principal(['employee']),
      tenantContext: { tenantId: TENANT_ID, status: 'onboarding' },
    }),
    (error) => error?.code === 'PERMISSION_REQUIRED',
  );
});

test('missing required entitlement or provider verification fails readiness closed', async () => {
  const { service: pilot, state } = service({
    repositories: {
      capabilityHealthRepository: {
        async listByTenantIdAndIntegrationId() {
          return [{ capability: 'free_busy', status: 'degraded', lastSuccessAt: null }];
        },
      },
    },
  });
  state.entitlements.delete('microsoft.calendar');
  const result = await pilot.getReadiness({
    principal: principal(['tenant_admin']),
    tenantContext: { tenantId: TENANT_ID, status: 'onboarding' },
  });
  assert.equal(result.ready, false);
  assert.equal(result.checks.freeBusyVerified, false);
  assert.equal(result.checks.calendarEntitled, false);
});

test('lifecycle mutation is operator-only, readiness-gated and emits server audit evidence', async () => {
  const denied = service().service;
  await assert.rejects(
    denied.setLifecycle({
      operatorContext: {},
      tenantId: TENANT_ID,
      targetStatus: 'active',
      correlationId: CORRELATION_ID,
    }),
    /OPERATOR_NOT_AUTHORIZED/,
  );

  const { service: allowed } = service({ authorizeOperator: async () => true });
  const result = await allowed.setLifecycle({
    operatorContext: { source: 'trusted_control_plane' },
    tenantId: TENANT_ID,
    targetStatus: 'ready',
    correlationId: CORRELATION_ID,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.auditEvent.action, 'tenant.lifecycle.changed');
  assert.deepEqual(result.auditEvent.previousState, { status: 'onboarding' });
  assert.deepEqual(result.auditEvent.newState, { status: 'ready' });
});

test('lifecycle allows only the documented forward, suspension and reactivation transitions', async () => {
  for (const [currentStatus, targetStatus] of [
    ['onboarding', 'ready'],
    ['ready', 'active'],
    ['active', 'suspended'],
    ['suspended', 'active'],
  ]) {
    const { service: pilot } = service({
      authorizeOperator: async () => true,
      repositories: { tenantRepository: lifecycleRepository(currentStatus) },
    });
    const result = await pilot.setLifecycle({
      operatorContext: { source: 'trusted_control_plane' },
      tenantId: TENANT_ID,
      targetStatus,
      correlationId: CORRELATION_ID,
    });
    assert.equal(result.status, targetStatus);
  }

  for (const [currentStatus, targetStatus] of [
    ['pending', 'ready'],
    ['onboarding', 'active'],
    ['ready', 'suspended'],
    ['active', 'ready'],
    ['suspended', 'ready'],
    ['archived', 'ready'],
    ['archived', 'active'],
    ['archived', 'suspended'],
  ]) {
    const { service: pilot } = service({
      authorizeOperator: async () => true,
      repositories: { tenantRepository: lifecycleRepository(currentStatus) },
    });
    await assert.rejects(
      pilot.setLifecycle({
        operatorContext: { source: 'trusted_control_plane' },
        tenantId: TENANT_ID,
        targetStatus,
        correlationId: CORRELATION_ID,
      }),
      (error) => error?.code === 'TENANT_PILOT_LIFECYCLE_CONFLICT',
    );
  }
});

test('stale lifecycle persistence conflicts fail instead of reporting completion', async () => {
  let attemptedChange = null;
  const repository = lifecycleRepository('onboarding', {
    async changeStatus(values) {
      attemptedChange = values;
      return null;
    },
  });
  const { service: pilot } = service({
    authorizeOperator: async () => true,
    repositories: { tenantRepository: repository },
  });

  await assert.rejects(
    pilot.setLifecycle({
      operatorContext: { source: 'trusted_control_plane' },
      tenantId: TENANT_ID,
      targetStatus: 'ready',
      correlationId: CORRELATION_ID,
    }),
    (error) => error?.code === 'TENANT_PILOT_LIFECYCLE_CONFLICT',
  );
  assert.equal(attemptedChange.expectedStatus, 'onboarding');
  assert.equal(attemptedChange.targetStatus, 'ready');
});
