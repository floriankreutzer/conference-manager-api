import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantCapabilityViewService } from '../src/application/tenant-capability-view-service.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function principal(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ['employee', 'tenant_admin'],
    permissions: [
      'request:read',
      'request:cancel',
      'tenant:configure',
      'tenant:users:manage',
      'tenant:integrations:manage',
      'tenant:audit:read',
    ],
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    checks: {
      tenantIdentityClaimed: true,
      microsoft365Connected: true,
      placesPermissionGranted: true,
      calendarPermissionGranted: true,
      roomImported: true,
      freeBusyVerified: true,
      directoryEntitled: true,
      calendarEntitled: true,
    },
    entitlements: {
      microsoftDirectory: true,
      microsoftCalendar: true,
      microsoftCalendarWrite: false,
    },
    ...overrides,
  };
}

function health(status = 'healthy', lastCheckedAt = '2026-08-27T10:00:00.000Z') {
  return { status, reason: null, lastCheckedAt, lastSuccessAt: lastCheckedAt };
}

function harness({ readinessValue = readiness(), connectionValue, rolloutPolicy } = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  let readinessCalls = 0;
  let connectionCalls = 0;
  const defaultConnection = {
    status: 'connected',
    capabilities: {
      places: health(),
      freeBusy: health(),
      calendarWrite: health('not_configured', null),
    },
  };
  return {
    audit,
    calls: () => ({ readinessCalls, connectionCalls }),
    service: createTenantCapabilityViewService({
      authorizationPolicy,
      auditService: audit.service,
      readinessService: {
        async getReadiness() {
          readinessCalls += 1;
          return readinessValue;
        },
      },
      microsoft365Service: {
        async getConnection() {
          connectionCalls += 1;
          return connectionValue ?? defaultConnection;
        },
      },
      rolloutPolicy,
      clock: () => NOW,
    }),
  };
}

function byId(view, id) {
  return view.capabilities.find((capability) => capability.id === id);
}

test('effective capability view keeps entitlement, rollout and provider readiness separate', async () => {
  const values = harness();
  const view = await values.service.getView({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(view.readOnly, true);
  assert.equal(byId(view, 'tenant.user_administration').state, 'operational');
  assert.equal(byId(view, 'microsoft.directory').state, 'operational');
  assert.equal(byId(view, 'microsoft.calendar').state, 'operational');
  assert.deepEqual(byId(view, 'microsoft.calendar.write'), {
    id: 'microsoft.calendar.write',
    availability: 'optional',
    state: 'not_entitled',
    reasonCodes: ['entitlement_missing'],
    action: null,
    lastCheckedAt: null,
  });
  assert.deepEqual(values.calls(), { readinessCalls: 1, connectionCalls: 1 });
});

test('unknown rollout and health, stale readiness and missing provider authority fail closed', async () => {
  const unknownRollout = harness({
    rolloutPolicy: {
      stateFor(id) {
        return id === 'microsoft.directory' ? 'browser_enabled' : 'not_controlled';
      },
    },
  });
  const unknownRolloutView = await unknownRollout.service.getView({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(byId(unknownRolloutView, 'microsoft.directory').state, 'unavailable');
  assert.deepEqual(byId(unknownRolloutView, 'microsoft.directory').reasonCodes, ['rollout_state_unknown']);

  const unknownHealth = harness({
    connectionValue: {
      status: 'connected',
      capabilities: {
        places: health('browser_enabled'),
        freeBusy: health('healthy', '2026-08-25T10:00:00.000Z'),
        calendarWrite: health('not_configured', null),
      },
    },
  });
  const healthView = await unknownHealth.service.getView({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(byId(healthView, 'microsoft.directory').state, 'unavailable');
  assert.equal(byId(healthView, 'microsoft.calendar').state, 'degraded');
  assert.deepEqual(byId(healthView, 'microsoft.calendar').reasonCodes, ['readiness_stale']);

  const rawConnectionOnly = harness({
    connectionValue: {
      status: 'connected',
      placesPermission: 'granted',
      calendarsPermission: 'granted',
      lastVerifiedAt: '2026-08-27T10:00:00.000Z',
    },
  });
  const rawConnectionView = await rawConnectionOnly.service.getView({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(byId(rawConnectionView, 'microsoft.directory').state, 'unavailable');
  assert.deepEqual(
    byId(rawConnectionView, 'microsoft.directory').reasonCodes,
    ['provider_health_unknown'],
  );

  const noIntegrationAuthority = harness();
  const view = await noIntegrationAuthority.service.getView({
    principal: principal({
      permissions: ['tenant:configure', 'tenant:users:manage', 'tenant:audit:read'],
    }),
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(byId(view, 'microsoft.directory').state, 'unavailable');
  assert.deepEqual(byId(view, 'microsoft.directory').reasonCodes, ['authority_missing']);
  assert.deepEqual(noIntegrationAuthority.calls(), { readinessCalls: 0, connectionCalls: 0 });
});

test('non-active or unknown Tenant lifecycle can never appear operational', async () => {
  for (const status of ['suspended', 'ready', 'future_state']) {
    const values = harness();
    const view = await values.service.getView({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID, status },
      correlationId: CORRELATION_ID,
    });
    assert.equal(view.capabilities.every((capability) => capability.state === 'unavailable'), true);
    assert.deepEqual(values.calls(), { readinessCalls: 0, connectionCalls: 0 });
  }
});

test('capability view requires Tenant Admin configuration authority and audits denial', async () => {
  const values = harness();
  await assert.rejects(
    values.service.getView({
      principal: principal({ roles: ['employee'], permissions: ['request:read'] }),
      tenantContext: { tenantId: TENANT_ID, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(values.audit.events.at(-1).action, 'authorization.denied');
});
