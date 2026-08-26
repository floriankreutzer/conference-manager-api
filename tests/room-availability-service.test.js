import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationDeniedError, AuthorizationInputError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
} from '../src/authorization/policy.js';
import {
  RoomAvailabilityUnavailableError,
  createRoomAvailabilityService,
} from '../src/application/room-availability-service.js';
import { EntitlementDeniedError } from '../src/entitlements/errors.js';
import { CalendarProviderError, PROVIDER_ERROR_KIND } from '../src/integrations/calendar-contract.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

const principal = Object.freeze({
  userId: USER_ID,
  tenantId: TENANT_ID,
  roles: Object.freeze([TENANT_ROLE.EMPLOYEE]),
  permissions: Object.freeze([PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL]),
});
const tenantContext = Object.freeze({ tenantId: TENANT_ID, status: 'active' });
const query = Object.freeze({
  roomId: 'room-a',
  startsAt: '2026-09-01T10:00:00.000Z',
  endsAt: '2026-09-01T11:00:00.000Z',
});

function harness({ localConflict = false, localError, providerResult, entitlementError, providerError } = {}) {
  const calls = [];
  const service = createRoomAvailabilityService({
    repository: {
      async hasConflictingRequest(values) {
        calls.push(['local', values]);
        if (localError) throw localError;
        return localConflict;
      },
    },
    authorizationPolicy: createAuthorizationPolicy(),
    entitlementService: {
      async requireAccess(values) {
        calls.push(['entitlement', values]);
        if (entitlementError) throw entitlementError;
        return true;
      },
    },
    calendarProviderFactory: {
      async forRoom(values) {
        calls.push(['provider', values]);
        if (providerError) throw providerError;
        return {
          async lookupAvailability(input) {
            calls.push(['lookup', input]);
            return providerResult || { available: true, conflictCount: 0, eventSubject: 'must-not-leak' };
          },
        };
      },
    },
  });
  return { service, calls };
}

function check(service, overrides = {}) {
  return service.checkAvailability({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    query,
    ...overrides,
  });
}

test('production room availability is Tenant-bound, entitlement-gated and minimized', async () => {
  const { service, calls } = harness();
  assert.deepEqual(await check(service), { available: true, conflictCount: 0 });
  assert.deepEqual(calls.map(([type]) => type), ['entitlement', 'local', 'provider', 'lookup']);
  assert.deepEqual(calls[1][1], {
    tenantId: TENANT_ID,
    roomId: 'room-a',
    startsAt: query.startsAt,
    endsAt: query.endsAt,
    excludeRequestId: null,
  });
  assert.equal(calls[3][1].tenantId, TENANT_ID);
  assert.equal(calls[3][1].roomId, 'room-a');
  assert.equal(Object.hasOwn(await check(service), 'eventSubject'), false);
});

test('a local overlap returns busy without calling Microsoft Graph', async () => {
  const { service, calls } = harness({ localConflict: true });
  assert.deepEqual(await check(service), { available: false, conflictCount: 1 });
  assert.deepEqual(calls.map(([type]) => type), ['entitlement', 'local']);
});

test('missing entitlement and provider failures never become available', async () => {
  const disabled = harness({ entitlementError: new EntitlementDeniedError() });
  await assert.rejects(check(disabled.service), RoomAvailabilityUnavailableError);
  assert.deepEqual(disabled.calls.map(([type]) => type), ['entitlement']);

  const unavailable = harness({
    providerError: new CalendarProviderError(PROVIDER_ERROR_KIND.UNAVAILABLE, { operation: 'availability' }),
  });
  await assert.rejects(check(unavailable.service), RoomAvailabilityUnavailableError);

  const malformed = harness({ providerResult: { available: true, conflictCount: 1 } });
  await assert.rejects(check(malformed.service), RoomAvailabilityUnavailableError);

  const genericEntitlementFailure = harness({ entitlementError: new Error('database unavailable') });
  await assert.rejects(check(genericEntitlementFailure.service), RoomAvailabilityUnavailableError);

  const localRepositoryFailure = harness({ localError: new Error('database unavailable') });
  await assert.rejects(check(localRepositoryFailure.service), RoomAvailabilityUnavailableError);

  const genericProviderFailure = harness({ providerError: new Error('factory unavailable') });
  await assert.rejects(check(genericProviderFailure.service), RoomAvailabilityUnavailableError);
});

test('cross-Tenant, authority-shaped and unbounded availability inputs fail before provider use', async () => {
  const { service, calls } = harness();
  await assert.rejects(
    check(service, { tenantContext: { tenantId: OTHER_TENANT_ID, status: 'active' } }),
    AuthorizationDeniedError,
  );
  await assert.rejects(
    check(service, { query: { ...query, tenantId: TENANT_ID } }),
    AuthorizationInputError,
  );
  await assert.rejects(
    check(service, {
      query: {
        ...query,
        endsAt: '2026-09-03T11:00:00.000Z',
      },
    }),
    AuthorizationInputError,
  );
  assert.equal(calls.length, 0);
});
