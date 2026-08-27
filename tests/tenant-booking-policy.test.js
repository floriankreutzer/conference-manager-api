import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';
import { createTenantBookingPolicyService } from '../src/application/tenant-booking-policy-service.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import {
  BOOKING_POLICY_OPERATION,
  TenantBookingPolicyInputError,
  TenantBookingPolicyViolationError,
  assertTenantBookingPolicyTransition,
  evaluateTenantBookingPolicy,
  evaluateTenantBookingPolicySnapshot,
  normalizeTenantBookingPolicies,
} from '../src/domain/tenant-booking-policies.js';
import { createAuditHarness } from './support/audit-harness.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-03-29T00:30:00.000Z';

function rules(overrides = {}) {
  return {
    minimumLeadTimeMinutes: 60,
    maximumAdvanceMinutes: 525_600,
    cancellationWindowMinutes: 120,
    changeWindowMinutes: 180,
    maximumParticipants: 20,
    allowedSiteIds: ['site-1'],
    allowedRoomIds: ['room-1'],
    allowedServiceIds: ['service-1'],
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    versions: [{
      id: 'policy-v1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      rules: rules(),
    }],
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    operation: BOOKING_POLICY_OPERATION.CREATE,
    evaluationInstant: new Date(NOW),
    startsAt: new Date('2026-03-29T01:30:00.000Z'),
    siteId: 'site-1',
    roomId: 'room-1',
    serviceIds: ['service-1'],
    participants: 20,
    ...overrides,
  };
}

function principal(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    userId: USER_ID,
    roles: [TENANT_ROLE.TENANT_ADMIN],
    permissions: [PERMISSION.TENANT_CONFIGURE],
    ...overrides,
  };
}

test('booking-policy schemas expose only bounded configurable rules', () => {
  const normalized = normalizeTenantBookingPolicies(configuration());
  assert.equal(normalized.versions[0].rules.maximumParticipants, 20);
  assert.throws(
    () => normalizeTenantBookingPolicies(configuration({
      versions: [{
        ...configuration().versions[0],
        rules: {
          ...rules(),
          mayBypassFinalAvailability: true,
        },
      }],
    })),
    (error) => (
      error instanceof TenantBookingPolicyInputError
      && error.code === 'TENANT_BOOKING_POLICIES_INVALID'
    ),
  );
  assert.throws(
    () => normalizeTenantBookingPolicies(configuration({
      versions: [{
        ...configuration().versions[0],
        rules: rules({ minimumLeadTimeMinutes: 525_601 }),
      }],
    })),
    (error) => (
      error instanceof TenantBookingPolicyInputError
      && error.code === 'TENANT_BOOKING_POLICY_LEAD_TIME_INVALID'
    ),
  );
});

test('effective policy versions are immutable and cannot be inserted retroactively', () => {
  const current = configuration();
  assert.throws(
    () => assertTenantBookingPolicyTransition(
      current,
      configuration({
        versions: [{
          ...current.versions[0],
          rules: rules({ maximumParticipants: 30 }),
        }],
      }),
      new Date(NOW),
    ),
    (error) => (
      error instanceof TenantBookingPolicyInputError
      && error.code === 'TENANT_BOOKING_POLICY_EFFECTIVE_VERSION_IMMUTABLE'
    ),
  );
  assert.throws(
    () => assertTenantBookingPolicyTransition(
      current,
      configuration({
        versions: [
          ...current.versions,
          {
            id: 'retroactive',
            effectiveFrom: '2026-03-01T00:00:00.000Z',
            rules: rules(),
          },
        ],
      }),
      new Date(NOW),
    ),
    (error) => (
      error instanceof TenantBookingPolicyInputError
      && error.code === 'TENANT_BOOKING_POLICY_RETROACTIVE_VERSION_FORBIDDEN'
    ),
  );
  const proposed = assertTenantBookingPolicyTransition(
    current,
    configuration({
      versions: [
        ...current.versions,
        {
          id: 'future',
          effectiveFrom: '2026-04-01T00:00:00.000Z',
          rules: rules({ maximumParticipants: 30 }),
        },
      ],
    }),
    new Date(NOW),
  );
  assert.equal(proposed.versions.length, 2);
});

test('elapsed UTC policy windows remain deterministic across a DST boundary', () => {
  const accepted = evaluateTenantBookingPolicy(configuration(), context());
  assert.equal(accepted.policyVersionId, 'policy-v1');
  assert.equal(accepted.evaluatedAt, NOW);
  assert.throws(
    () => evaluateTenantBookingPolicy(
      configuration(),
      context({ startsAt: new Date('2026-03-29T01:29:00.000Z') }),
    ),
    (error) => (
      error instanceof TenantBookingPolicyViolationError
      && error.code === 'BOOKING_POLICY_LEAD_TIME_VIOLATION'
      && error.parameters.requiredMinutes === 60
    ),
  );
});

test('policy minute boundaries do not round away partial-minute violations', () => {
  const boundedConfiguration = configuration({
    versions: [{
      ...configuration().versions[0],
      rules: rules({
        maximumAdvanceMinutes: 120,
        cancellationWindowMinutes: 0,
        changeWindowMinutes: 0,
      }),
    }],
  });
  const common = {
    operation: BOOKING_POLICY_OPERATION.CREATE,
    evaluationInstant: new Date('2026-08-27T10:00:00.000Z'),
    siteId: 'site-1',
    roomId: 'room-1',
    serviceIds: ['service-1'],
    participants: 1,
  };
  assert.throws(
    () => evaluateTenantBookingPolicy(boundedConfiguration, {
      ...common,
      startsAt: new Date('2026-08-27T10:59:59.999Z'),
    }),
    (error) => error.code === 'BOOKING_POLICY_LEAD_TIME_VIOLATION',
  );
  assert.throws(
    () => evaluateTenantBookingPolicy(boundedConfiguration, {
      ...common,
      startsAt: new Date('2026-08-27T12:00:00.001Z'),
    }),
    (error) => error.code === 'BOOKING_POLICY_ADVANCE_WINDOW_VIOLATION',
  );
});

test('booking policy rejects participant, applicability, change and cancellation violations', () => {
  const cases = [
    [
      context({ participants: 21 }),
      'BOOKING_POLICY_PARTICIPANT_LIMIT_VIOLATION',
    ],
    [
      context({ roomId: 'room-2' }),
      'BOOKING_POLICY_ROOM_NOT_ALLOWED',
    ],
    [
      context({ serviceIds: ['service-2'] }),
      'BOOKING_POLICY_SERVICE_NOT_ALLOWED',
    ],
    [
      context({
        operation: BOOKING_POLICY_OPERATION.CHANGE,
        startsAt: new Date('2026-03-29T03:29:00.000Z'),
      }),
      'BOOKING_POLICY_CHANGE_WINDOW_VIOLATION',
    ],
    [
      context({
        operation: BOOKING_POLICY_OPERATION.CANCEL,
        startsAt: new Date('2026-03-29T02:29:00.000Z'),
      }),
      'BOOKING_POLICY_CANCELLATION_WINDOW_VIOLATION',
    ],
  ];
  for (const [value, code] of cases) {
    assert.throws(
      () => evaluateTenantBookingPolicy(configuration(), value),
      (error) => (
        error instanceof TenantBookingPolicyViolationError
        && error.code === code
      ),
    );
  }
});

test('historical Request enforcement keeps its immutable policy snapshot', () => {
  const snapshot = evaluateTenantBookingPolicy(configuration(), context());
  const changedConfiguration = configuration({
    versions: [
      ...configuration().versions,
      {
        id: 'policy-v2',
        effectiveFrom: '2026-04-01T00:00:00.000Z',
        rules: rules({ cancellationWindowMinutes: 240 }),
      },
    ],
  });
  const cancellation = context({
    operation: BOOKING_POLICY_OPERATION.CANCEL,
    evaluationInstant: new Date('2026-04-02T10:00:00.000Z'),
    startsAt: new Date('2026-04-02T13:00:00.000Z'),
  });
  assert.throws(
    () => evaluateTenantBookingPolicy(changedConfiguration, cancellation),
    (error) => (
      error instanceof TenantBookingPolicyViolationError
      && error.code === 'BOOKING_POLICY_CANCELLATION_WINDOW_VIOLATION'
    ),
  );
  const historical = evaluateTenantBookingPolicySnapshot(snapshot, cancellation);
  assert.equal(historical.policyVersionId, 'policy-v1');
  assert.equal(historical.enforcedAt, '2026-04-02T10:00:00.000Z');
});

function serviceRuntime({ conflict = null } = {}) {
  const calls = [];
  let currentReads = 0;
  const repository = {
    async current(tenantId) {
      assert.equal(tenantId, TENANT_ID);
      currentReads += 1;
      return { revision: 4, configuration: configuration() };
    },
    async update(args) {
      calls.push(args);
      if (conflict !== null) return { status: 'conflict', currentRevision: conflict };
      return { revision: args.nextRevision, configuration: args.configuration };
    },
    async history() {
      return [];
    },
    async revision() {
      return null;
    },
  };
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  return {
    calls,
    currentReads: () => currentReads,
    service: createTenantBookingPolicyService({
      repository,
      authorizationPolicy,
      auditService: audit.service,
      clock: () => Date.parse(NOW),
    }),
  };
}

test('Tenant Admin policy mutation is revisioned and creates bounded audit evidence', async () => {
  const { calls, service } = serviceRuntime();
  const result = await service.update({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 4,
    configuration: configuration(),
  });
  assert.equal(result.revision, 5);
  assert.equal(calls[0].tenantId, TENANT_ID);
  assert.equal(calls[0].actorUserId, USER_ID);
  assert.equal(calls[0].auditEvent.action, 'tenant.configuration.changed');
  assert.equal(calls[0].auditEvent.metadata.domain, 'booking_policies');
  assert.equal(Object.hasOwn(calls[0].auditEvent.metadata, 'tenantId'), false);
});

test('policy administration denies missing permission and cross-Tenant context', async () => {
  const { calls, service } = serviceRuntime();
  const employee = principal({
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ],
  });
  const input = {
    principal: employee,
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 4,
    configuration: configuration(),
  };
  await assert.rejects(service.update(input), AuthorizationDeniedError);
  await assert.rejects(
    service.update({
      ...input,
      principal: principal(),
      tenantContext: { tenantId: OTHER_TENANT_ID },
    }),
    AuthorizationDeniedError,
  );
  assert.equal(calls.length, 0);
});

test('stale policy writes expose current revision without a successful mutation', async () => {
  const { calls, service } = serviceRuntime({ conflict: 7 });
  await assert.rejects(
    service.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 4,
      configuration: configuration(),
    }),
    (error) => (
      error instanceof TenantSettingsConflictError
      && error.currentRevision === 7
    ),
  );
  assert.equal(calls.length, 1);
});

test('policy service rejects unsupported settings schema before persistence', async () => {
  const { calls, service } = serviceRuntime();
  await assert.rejects(
    service.update({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      schemaVersion: 2,
      expectedRevision: 4,
      configuration: configuration(),
    }),
    TenantSettingsInputError,
  );
  assert.equal(calls.length, 0);
});

test('policy service reuses the persisted Request snapshot for later enforcement', async () => {
  const runtime = serviceRuntime();
  const snapshot = await runtime.service.evaluateCurrentForRequest({
    tenantId: TENANT_ID,
    operation: BOOKING_POLICY_OPERATION.CREATE,
    startsAt: new Date('2026-03-29T01:30:00.000Z'),
    siteId: 'site-1',
    roomId: 'room-1',
    serviceIds: ['service-1'],
    participants: 10,
  });
  assert.equal(snapshot.configurationRevision, 4);
  assert.equal(runtime.currentReads(), 1);
  const enforced = await runtime.service.evaluateSnapshotForRequest({
    tenantId: TENANT_ID,
    snapshot,
    operation: BOOKING_POLICY_OPERATION.CANCEL,
    startsAt: new Date('2026-03-29T02:30:00.000Z'),
    siteId: 'site-1',
    roomId: 'room-1',
    serviceIds: ['service-1'],
    participants: 10,
  });
  assert.equal(enforced.policyVersionId, 'policy-v1');
  assert.equal(enforced.configurationRevision, 4);
  assert.equal(runtime.currentReads(), 1);
});
