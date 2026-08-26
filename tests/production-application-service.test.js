import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SiteTimeZoneRequiredError,
  createProductionApplicationService,
} from '../src/application/production-application-service.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';

const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const USER_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = '77777777-7777-4777-8777-777777777777';
const NOTIFICATION_ID = '88888888-8888-4888-8888-888888888888';

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

function tenantAdmin() {
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
    async loadCatalog(tenantId) {
      calls.push(['loadCatalog', tenantId]);
      return { sites: [], rooms: [], services: [], cateringPackages: [], cateringItems: [] };
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
    async updateSites(args) {
      calls.push(['updateSites', args]);
      return args.sites;
    },
  };
  const requestRepository = {
    async listByTenantId(tenantId, scope) {
      calls.push(['listRequests', tenantId, scope]);
      return [];
    },
    async createForTenant(args) {
      calls.push(['createRequest', args]);
      return {
        tenantId: args.tenantId,
        id: args.requestId,
        requesterUserId: args.requesterUserId,
        roomId: args.roomId,
        status: 'Submitted',
        statusReason: null,
        startsAt: args.startsAt.toISOString(),
        endsAt: args.endsAt.toISOString(),
        internalParticipants: args.internalParticipants,
        externalParticipants: args.externalParticipants,
        statusChangedAt: args.createdAt.toISOString(),
        createdAt: args.createdAt.toISOString(),
        updatedAt: args.createdAt.toISOString(),
      };
    },
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
  });
  await service.listRequests({
    principal: manager(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
  });
  assert.deepEqual(calls[0], ['listRequests', TENANT_A, { requesterUserId: USER_A }]);
  assert.deepEqual(calls[1], ['listRequests', TENANT_A, { requesterUserId: null }]);
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

test('request creation rejects authority-shaped fields and derives identity/status server-side', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.createRequest({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      requestDraft: {
        roomId: 'room-a',
        startsAt: '2026-09-01T10:00:00.000Z',
        endsAt: '2026-09-01T11:00:00.000Z',
        internalParticipants: 2,
        externalParticipants: 1,
        tenantId: TENANT_B,
      },
    }),
    AuthorizationInputError,
  );
  assert.equal(calls.length, 0);

  const created = await service.createRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    requestDraft: {
      roomId: 'room-a',
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
      internalParticipants: 2,
      externalParticipants: 1,
    },
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
  assert.deepEqual(createCall.auditEvent.newState, { status: 'Submitted' });
});

test('request creation accepts only the canonical availability window contract', async () => {
  const valid = {
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-02T10:00:00.000Z',
    internalParticipants: 1,
    externalParticipants: 0,
  };

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
        requestDraft,
      }),
      (error) => error instanceof AuthorizationInputError
        && error.message === 'REQUEST_SCHEDULE_INVALID',
    );
    assert.equal(calls.some(([name]) => name === 'createRequest'), false);
  }

  const { service } = harness();
  const created = await service.createRequest({
    principal: employee(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    requestDraft: valid,
  });
  assert.equal(created.startsAt, valid.startsAt);
  assert.equal(created.endsAt, valid.endsAt);
});

test('request creation fails closed when atomic persistence revalidation rejects the room', async () => {
  const { service, requestRepository } = harness();
  requestRepository.createForTenant = async () => null;

  await assert.rejects(
    service.createRequest({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      requestDraft: {
        roomId: 'room-a',
        startsAt: '2026-09-01T10:00:00.000Z',
        endsAt: '2026-09-01T11:00:00.000Z',
        internalParticipants: 1,
        externalParticipants: 0,
      },
    }),
    (error) => error instanceof AuthorizationDeniedError
      && error.code === 'RESOURCE_NOT_AVAILABLE'
      && error.conceal === true,
  );
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

test('tenant configuration requires Tenant Admin permission and positive site schema', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    service.updateConfiguration({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      configuration: { sites: [] },
    }),
    AuthorizationDeniedError,
  );
  assert.equal(calls.length, 0);

  const updated = await service.updateConfiguration({
    principal: tenantAdmin(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    configuration: {
      sites: [{ id: 'berlin', name: 'Berlin', active: true, timeZone: 'Europe/Berlin' }],
    },
  });
  assert.deepEqual(updated.sites, [
    { id: 'berlin', name: 'Berlin', active: true, timeZone: 'Europe/Berlin' },
  ]);

  await assert.rejects(
    service.updateConfiguration({
      principal: tenantAdmin(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      configuration: { sites: [{ id: 'berlin', name: 'Berlin', active: true }] },
    }),
    AuthorizationInputError,
  );

  const utc = await service.updateConfiguration({
    principal: tenantAdmin(),
    tenantContext: { tenantId: TENANT_A },
    correlationId: CORRELATION_ID,
    configuration: { sites: [{ id: 'utc', name: 'UTC Site', active: true, timeZone: 'UTC' }] },
  });
  assert.equal(utc.sites[0].timeZone, 'UTC');

  await assert.rejects(
    service.updateConfiguration({
      principal: tenantAdmin(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      configuration: {
        sites: [{
          id: 'berlin',
          name: 'Berlin',
          active: true,
          timeZone: 'Europe/Berlin',
          tenantId: TENANT_B,
        }],
      },
    }),
    AuthorizationInputError,
  );
});

test('request creation and availability fail closed when the Site time zone is missing', async () => {
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
  const requestDraft = {
    roomId: 'room-a',
    startsAt: '2026-09-01T10:00:00.000Z',
    endsAt: '2026-09-01T11:00:00.000Z',
    internalParticipants: 1,
    externalParticipants: 0,
  };

  await assert.rejects(
    service.createRequest({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      requestDraft,
    }),
    SiteTimeZoneRequiredError,
  );
  await assert.rejects(
    service.checkRoomAvailability({
      principal: employee(),
      tenantContext: { tenantId: TENANT_A },
      correlationId: CORRELATION_ID,
      query: {
        roomId: requestDraft.roomId,
        startsAt: requestDraft.startsAt,
        endsAt: requestDraft.endsAt,
      },
    }),
    SiteTimeZoneRequiredError,
  );

  assert.equal(calls.filter(([name]) => name === 'createRequest').length, 0);
  assert.equal(availabilityCalls.length, 0);
});
