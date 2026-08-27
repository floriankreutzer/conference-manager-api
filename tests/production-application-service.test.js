import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SiteTimeZoneRequiredError,
  createProductionApplicationService,
} from '../src/application/production-application-service.js';
import {
  AuthorizationDeniedError,
  RequestStateConflictError,
} from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import {
  RequestCompositionInputError,
  RequestCompositionUnavailableError,
  createRequestV2Snapshot,
  priceRequestComposition,
} from '../src/domain/request-composition.js';
import { toPublicRequest } from '../src/domain/request.js';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777';
const NOTIFICATION_ID = '88888888-8888-4888-8888-888888888888';
const AT = '2026-08-25T11:00:00.000Z';

function revisions() {
  return {
    organization: 1,
    locations: 1,
    catalogue: 1,
    bookingPolicies: 1,
    costAllocation: 1,
  };
}

function requestDraft(overrides = {}) {
  return {
    title: 'Planning session',
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 2,
    externalParticipants: 1,
    serviceIds: [],
    catering: { participantCount: 0, packageSelection: null, itemQuantities: [] },
    dietaryRequirements: null,
    specialRequirements: null,
    allocations: [],
    configurationRevisions: revisions(),
    ...overrides,
  };
}

function requestSnapshot(draft, requestVersion = 1) {
  const room = { id: draft.roomId, siteId: 'site-a', name: 'Room A', price: { amountMinor: 0, currency: 'EUR' } };
  const catalogueSnapshot = {
    schemaVersion: 1,
    catalogRevision: 1,
    capturedAt: AT,
    siteId: 'site-a',
    roomId: draft.roomId,
    services: [],
    equipment: [],
    cateringItems: [],
    catering: [],
  };
  const pricing = priceRequestComposition({ draft, room, catalogueSnapshot, defaultCurrency: 'EUR' });
  return createRequestV2Snapshot({
    draft,
    requestVersion,
    capturedAt: AT,
    room,
    catalogueSnapshot,
    bookingPolicySnapshot: {
      policyVersionId: 'policy-v1',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      evaluatedAt: AT,
      rules: {
        minimumLeadTimeMinutes: 0,
        maximumAdvanceMinutes: 527_040,
        cancellationWindowMinutes: 0,
        changeWindowMinutes: 0,
        maximumParticipants: 500,
        allowedSiteIds: [],
        allowedRoomIds: [],
        allowedServiceIds: [],
      },
    },
    allocationSnapshot: {
      schemaVersion: 1,
      configurationRevision: 1,
      snapshottedAt: AT,
      model: 'percentage_basis_points',
      totalBasisPoints: 0,
      totalMinor: pricing.totalMinor,
      allocatedMinor: 0,
      unallocatedMinor: pricing.totalMinor,
      currency: pricing.currency,
      entries: [],
    },
    revisions: revisions(),
    defaultCurrency: 'EUR',
  });
}

function storedRequest(id, startsAt, overrides = {}) {
  const endsAt = new Date(Date.parse(startsAt) + 60 * 60 * 1_000).toISOString();
  const draft = requestDraft({ title: `Report ${id}`, startsAt, endsAt });
  return {
    tenantId: TENANT_A,
    id,
    requesterUserId: USER_A,
    schemaVersion: 2,
    version: 1,
    roomId: draft.roomId,
    status: 'Confirmed',
    statusReason: null,
    startsAt,
    endsAt,
    internalParticipants: draft.internalParticipants,
    externalParticipants: draft.externalParticipants,
    statusChangedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    snapshot: requestSnapshot(draft),
    ...overrides,
  };
}

function employee(overrides = {}) {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    roles: [TENANT_ROLE.EMPLOYEE],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
    ...overrides,
  };
}

function manager() {
  return employee({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER],
    permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL, PERMISSION.REQUEST_MANAGE],
  });
}

function tenantAdmin(overrides = {}) {
  return employee({
    roles: [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN],
    permissions: [
      PERMISSION.REQUEST_READ,
      PERMISSION.REQUEST_CANCEL,
      PERMISSION.TENANT_CONFIGURE,
      PERMISSION.TENANT_USERS_MANAGE,
      PERMISSION.TENANT_INTEGRATIONS_MANAGE,
      PERMISSION.TENANT_AUDIT_READ,
    ],
    ...overrides,
  });
}

function harness({
  bookingContext = { roomActive: true, siteActive: true, timeZone: 'Europe/Berlin' },
  roomAvailabilityService = null,
} = {}) {
  const calls = [];
  const repository = {
    async findProfile(tenantId, userId) {
      calls.push(['findProfile', tenantId, userId]);
      return { displayName: 'User A' };
    },
    async updateProfile(args) {
      calls.push(['updateProfile', args]);
      return { displayName: args.displayName };
    },
    async loadCatalogPage(args) {
      calls.push(['loadCatalogPage', args]);
      return {
        status: 'ready',
        configurationRevisions: revisions(),
        defaultCurrency: 'EUR',
        entries: [],
        bookingPolicy: {
          policyVersionId: 'platform-default-v1',
          effectiveFrom: '1970-01-01T00:00:00.000Z',
          evaluatedAt: AT,
          rules: {
            minimumLeadTimeMinutes: 0,
            maximumAdvanceMinutes: 527_040,
            cancellationWindowMinutes: 0,
            changeWindowMinutes: 0,
            maximumParticipants: 100_000,
            allowedSiteIds: [],
            allowedRoomIds: [],
            allowedServiceIds: [],
          },
        },
        allocationRequired: false,
      };
    },
    async loadSites(tenantId) {
      calls.push(['loadSites', tenantId]);
      return [];
    },
    async findRoomBookingContext(tenantId, roomId) {
      calls.push(['findRoomBookingContext', tenantId, roomId]);
      return bookingContext;
    },
    async listNotifications(tenantId, userId) {
      calls.push(['listNotifications', tenantId, userId]);
      return [{ id: NOTIFICATION_ID, kind: 'request', createdAt: '2026-08-25T10:00:00.000Z', readAt: null }];
    },
    async markNotificationRead(tenantId, userId, notificationId) {
      calls.push(['markNotificationRead', tenantId, userId, notificationId]);
      return notificationId === NOTIFICATION_ID
        ? { id: notificationId, kind: 'request', createdAt: '2026-08-25T10:00:00.000Z', readAt: '2026-08-25T11:00:00.000Z' }
        : null;
    },
  };
  const requestRepository = {
    async listPageByTenantId(args) {
      calls.push(['listRequests', args]);
      return {
        status: 'ready',
        snapshot: { revisionWatermark: 0, asOf: AT },
        requests: [],
      };
    },
    async listReportPageByTenantId(args) {
      calls.push(['listReportRequests', args]);
      return {
        status: 'ready',
        snapshot: { revisionWatermark: 0, asOf: AT },
        requests: [],
      };
    },
    async createVersionedForTenant(args) {
      calls.push(['createRequest', args]);
      const draft = args.requestDraft;
      return { status: 'created', request: {
        tenantId: args.tenantId,
        id: args.requestId,
        requesterUserId: args.requesterUserId,
        schemaVersion: 2,
        version: 1,
        roomId: draft.roomId,
        status: 'Submitted',
        statusReason: null,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
        internalParticipants: draft.internalParticipants,
        externalParticipants: draft.externalParticipants,
        statusChangedAt: args.createdAt.toISOString(),
        createdAt: args.createdAt.toISOString(),
        updatedAt: args.createdAt.toISOString(),
        snapshot: requestSnapshot(draft),
      } };
    },
    async resubmitVersionedForTenant() { throw new Error('UNEXPECTED_RESUBMIT'); },
  };
  const auditService = {
    createEvent(value) {
      return Object.freeze(value);
    },
  };
  const service = createProductionApplicationService({
    repository,
    requestRepository,
    authorizationPolicy: createAuthorizationPolicy(),
    auditService,
    roomAvailabilityService,
    clock: () => Date.parse('2026-08-25T11:00:00.000Z'),
    idFactory: () => REQUEST_ID,
  });
  return { service, calls, requestRepository };
}

test('request list scope is employee-owned and manager tenant-wide', async () => {
  const { service, calls } = harness();
  await service.listRequests({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query: { limit: undefined, cursor: undefined },
  });
  await service.listRequests({
    principal: manager(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query: { limit: undefined, cursor: undefined },
  });
  assert.deepEqual(calls[0], ['listRequests', {
    tenantId: TENANT_A,
    requesterUserId: USER_A,
    snapshot: null,
    afterStartsAt: null,
    afterRequestId: null,
    limit: 11,
  }]);
  assert.deepEqual(calls[1], ['listRequests', {
    tenantId: TENANT_A,
    requesterUserId: null,
    snapshot: null,
    afterStartsAt: null,
    afterRequestId: null,
    limit: 11,
  }]);
});

test('Manager Request report is UTC-range scoped, cursor-complete and uses public v2 records', async () => {
  const { service, requestRepository, calls } = harness();
  const rows = [
    toPublicRequest(storedRequest('REPORT-1', '2026-09-01T08:00:00.000Z')),
    toPublicRequest(storedRequest('REPORT-2', '2026-09-01T09:00:00.000Z')),
    toPublicRequest(storedRequest('REPORT-3', '2026-09-01T10:00:00.000Z')),
  ];
  requestRepository.listReportPageByTenantId = async (args) => {
    calls.push(['reportPage', args]);
    return {
      status: 'ready',
      snapshot: args.snapshot ?? { revisionWatermark: 12, asOf: AT },
      requests: args.afterRequestId === null ? rows : [rows[2]],
    };
  };
  const query = {
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-02T00:00:00.000Z',
    limit: '2',
    cursor: undefined,
  };
  const first = await service.getRequestReport({
    principal: manager(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query,
  });
  assert.deepEqual(first.range, {
    field: 'startsAt',
    fromInclusive: query.from,
    toExclusive: query.to,
    timeZone: 'UTC',
  });
  assert.equal(first.asOf, AT);
  assert.equal(first.requests.length, 2);
  assert.equal(first.requests[0].tenantId, undefined);
  assert.equal(first.requests[0].pricing.currency, 'EUR');
  assert.deepEqual(first.page, {
    limit: 2,
    complete: false,
    nextCursor: first.page.nextCursor,
  });
  assert.equal(typeof first.page.nextCursor, 'string');
  assert.equal(calls.at(-1)[1].limit, 3);
  assert.equal(calls.at(-1)[1].snapshot, null);

  const second = await service.getRequestReport({
    principal: manager(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query: { ...query, cursor: first.page.nextCursor },
  });
  assert.deepEqual(second.requests.map((request) => request.id), ['REPORT-3']);
  assert.deepEqual(second.page, { limit: 2, complete: true, nextCursor: null });
  assert.equal(calls.at(-1)[1].afterRequestId, 'REPORT-2');
  assert.deepEqual(calls.at(-1)[1].snapshot, { revisionWatermark: 12, asOf: AT });

  const beforeDenied = calls.length;
  await assert.rejects(service.getRequestReport({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query,
  }), AuthorizationDeniedError);
  assert.equal(calls.length, beforeDenied);

  await assert.rejects(service.getRequestReport({
    principal: tenantAdmin({
      permissions: [...tenantAdmin().permissions, PERMISSION.REQUEST_MANAGE],
    }),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query,
  }), AuthorizationDeniedError);
  assert.equal(calls.length, beforeDenied);

  await assert.rejects(service.getRequestReport({
    principal: manager(),
    tenantContext: { tenantId: TENANT_B },
    correlationId: CORRELATION_ID,
    query,
  }), AuthorizationDeniedError);
  assert.equal(calls.length, beforeDenied);
});

test('cross-tenant application access fails before repository access', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.getCatalog({
      principal: employee(),
      tenantContext: { tenantId: TENANT_B },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(calls.length, 0);
});

test('request drafting catalog pages bind current cost allocation, policy and freshness tokens', async () => {
  const { service, calls } = harness();
  const catalog = await service.getCatalog({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    query: { section: 'sites', limit: undefined, cursor: undefined, context: undefined },
  });
  assert.deepEqual(catalog.costAllocation, {
    allocationRequired: false,
  });
  assert.equal(catalog.configurationRevisions.costAllocation, 1);
  assert.equal(catalog.bookingPolicy.policyVersionId, 'platform-default-v1');
  assert.equal(catalog.bookingPolicy.rules.maximumAdvanceMinutes, 527_040);
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.section, 'sites');
  assert.deepEqual(catalog.organization, { defaultCurrency: 'EUR' });
  assert.equal(typeof catalog.context, 'string');
  assert.deepEqual(catalog.entries, []);
  assert.deepEqual(catalog.page, { limit: 10, complete: true, nextCursor: null });
  assert.deepEqual(calls, [['loadCatalogPage', {
    tenantId: TENANT_A,
    section: 'sites',
    afterId: null,
    limit: 11,
    expectedRevisions: null,
    expectedPolicyVersionId: null,
  }]]);
});

test('request creation rejects authority-shaped fields and derives identity/status server-side', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.createRequest({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      schemaVersion: 2,
      requestDraft: requestDraft({ tenantId: TENANT_B }),
    }),
    RequestCompositionInputError,
  );
  assert.equal(calls.length, 0);

  const created = await service.createRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    schemaVersion: 2,
    requestDraft: requestDraft(),
  });
  assert.equal(created.id, REQUEST_ID);
  assert.equal(created.status, 'Submitted');
  assert.equal(Object.hasOwn(created, 'tenantId'), false);
  assert.equal(Object.hasOwn(created, 'requesterUserId'), false);
  const createCall = calls.at(-1)[1];
  assert.equal(createCall.tenantId, TENANT_A);
  assert.equal(createCall.requesterUserId, USER_A);
  assert.equal(createCall.auditEvent.tenantContext.tenantId, TENANT_A);
  assert.equal(createCall.auditEvent.principal.userId, USER_A);
  assert.deepEqual(createCall.auditEvent.newState, {
    status: 'Submitted', schemaVersion: 2, requestVersion: 1,
  });
});

test('request creation accepts only the canonical availability window contract', async () => {
  const valid = requestDraft({
    endsAt: '2026-09-02T10:00:00.000Z',
    internalParticipants: 1,
    externalParticipants: 0,
  });

  for (const requestDraft of [
    { ...valid, startsAt: '2026-09-01T12:00:00+02:00' },
    { ...valid, startsAt: '2026-09-01T10:00:00' },
    { ...valid, startsAt: '2026-09-01T10:00:00Z' },
    { ...valid, endsAt: '2026-09-02T10:00:00.001Z' },
  ]) {
    const { service, calls } = harness();
    await assert.rejects(
      service.createRequest({
        principal: employee(),
        tenantContext: { tenantId: TENANT_A },
        correlationId: CORRELATION_ID,
        schemaVersion: 2,
        requestDraft,
      }),
      (error) => error instanceof RequestCompositionInputError
        && error.message === 'REQUEST_SCHEDULE_INVALID',
    );
    assert.equal(calls.some(([name]) => name === 'createRequest'), false);
  }

  const { service } = harness();
  const created = await service.createRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    schemaVersion: 2,
    requestDraft: valid,
  });
  assert.equal(created.startsAt, valid.startsAt);
  assert.equal(created.endsAt, valid.endsAt);
});

test('request creation fails closed when atomic persistence revalidation rejects the room', async () => {
  const { service, requestRepository } = harness();
  requestRepository.createVersionedForTenant = async () => {
    throw new RequestCompositionUnavailableError();
  };

  await assert.rejects(
    service.createRequest({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      schemaVersion: 2,
      requestDraft: requestDraft({ internalParticipants: 1, externalParticipants: 0 }),
    }),
    (error) => error instanceof RequestCompositionUnavailableError
      && error.code === 'REQUEST_CONFIGURATION_UNAVAILABLE',
  );
});

test('owner resubmission delegates the complete v2 draft and maps stale state to conflict', async () => {
  const { service, requestRepository, calls } = harness();
  requestRepository.resubmitVersionedForTenant = async (args) => {
    calls.push(['resubmitRequest', args]);
    return { status: 'resubmitted', request: {
      tenantId: args.tenantId,
      id: args.requestId,
      requesterUserId: args.requesterUserId,
      schemaVersion: 2,
      version: args.expectedVersion + 1,
      roomId: args.requestDraft.roomId,
      status: 'Submitted',
      statusReason: null,
      startsAt: args.requestDraft.startsAt,
      endsAt: args.requestDraft.endsAt,
      internalParticipants: args.requestDraft.internalParticipants,
      externalParticipants: args.requestDraft.externalParticipants,
      statusChangedAt: args.changedAt.toISOString(),
      createdAt: AT,
      updatedAt: args.changedAt.toISOString(),
      snapshot: requestSnapshot(args.requestDraft, args.expectedVersion + 1),
    } };
  };
  const proposed = requestDraft({ title: 'Owner resubmission' });
  const result = await service.resubmitRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    requestId: 'REQ-LEGACY',
    schemaVersion: 2,
    expectedVersion: 1,
    requestDraft: proposed,
  });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.version, 2);
  assert.equal(result.details.title, 'Owner resubmission');
  const call = calls.find(([name]) => name === 'resubmitRequest')[1];
  assert.equal(call.requesterUserId, USER_A);
  assert.deepEqual(call.requestDraft, proposed);

  requestRepository.resubmitVersionedForTenant = async () => ({ status: 'state_conflict' });
  await assert.rejects(service.resubmitRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    requestId: 'REQ-LEGACY',
    schemaVersion: 2,
    expectedVersion: 1,
    requestDraft: proposed,
  }), RequestStateConflictError);
});

test('notification ownership is always bound to the authenticated user', async () => {
  const { service, calls } = harness();
  await service.listNotifications({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
  });
  await service.markNotificationRead({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    notificationId: NOTIFICATION_ID,
  });
  assert.deepEqual(calls[0], ['listNotifications', TENANT_A, USER_A]);
  assert.deepEqual(calls[1], ['markNotificationRead', TENANT_A, USER_A, NOTIFICATION_ID]);
});

test('legacy tenant configuration is authorized read-only presentation', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.getConfiguration({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(calls.length, 0);

  const configuration = await service.getConfiguration({
    principal: tenantAdmin(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(configuration, { sites: [] });
  assert.deepEqual(calls, [['loadSites', TENANT_A]]);
  assert.equal(Object.hasOwn(service, 'updateConfiguration'), false);
});

test('availability fails closed on missing Site time zone while create delegates atomic authority', async () => {
  const availabilityCalls = [];
  const { service, calls } = harness({
    bookingContext: { roomActive: true, siteActive: true, timeZone: null },
    roomAvailabilityService: {
      async checkAvailability(value) {
        availabilityCalls.push(value);
        return { available: true, conflictCount: 0 };
      },
    },
  });
  const draft = requestDraft({ internalParticipants: 1, externalParticipants: 0 });

  const created = await service.createRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    schemaVersion: 2,
    requestDraft: draft,
  });
  assert.equal(created.schemaVersion, 2);
  await assert.rejects(
    service.checkRoomAvailability({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      query: {
        roomId: draft.roomId,
        startsAt: draft.startsAt,
        endsAt: draft.endsAt,
      },
    }),
    SiteTimeZoneRequiredError,
  );

  assert.equal(calls.filter(([name]) => name === 'createRequest').length, 1);
  assert.equal(availabilityCalls.length, 0);
});
