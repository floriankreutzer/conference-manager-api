import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionApplicationService } from '../src/application/production-application-service.js';
import { createRoomAvailabilityService } from '../src/application/room-availability-service.js';
import { PERMISSION, TENANT_ROLE, createAuthorizationPolicy } from '../src/authorization/policy.js';

const TENANT_ID = '21212121-2121-4121-8121-212121212121';
const USER_ID = '31313131-3131-4131-8131-313131313131';
const CORRELATION_ID = '41414141-4141-4141-8141-414141414141';

test('production application composition reaches Tenant-bound live room availability', async () => {
  const calls = [];
  const authorizationPolicy = createAuthorizationPolicy();
  const roomAvailabilityService = createRoomAvailabilityService({
    repository: {
      async hasConflictingRequest(values) {
        calls.push(['local', values]);
        return false;
      },
    },
    authorizationPolicy,
    entitlementService: {
      async requireAccess(values) {
        calls.push(['entitlement', values.capabilityId]);
        return true;
      },
    },
    calendarProviderFactory: {
      async forRoom(values) {
        calls.push(['provider', values]);
        return {
          async lookupAvailability(input) {
            calls.push(['lookup', input]);
            return { available: true, conflictCount: 0 };
          },
        };
      },
    },
  });
  const service = createProductionApplicationService({
    repository: {
      async findProfile() {},
      async updateProfile() {},
      async loadCatalog() {},
      async findRoomBookingContext(tenantId, roomId) {
        calls.push(['room-context', tenantId, roomId]);
        return { roomActive: true, siteActive: true, timeZone: 'Europe/Berlin' };
      },
      async listNotifications() {},
      async markNotificationRead() {},
      async updateSites() {},
    },
    requestRepository: {
      async listByTenantId() { return []; },
      async createForTenant() {},
    },
    authorizationPolicy,
    auditService: { createEvent(values) { return values; } },
    roomAvailabilityService,
  });
  const availability = await service.checkRoomAvailability({
    principal: {
      userId: USER_ID,
      tenantId: TENANT_ID,
      roles: [TENANT_ROLE.EMPLOYEE],
      permissions: [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
    },
    tenantContext: { tenantId: TENANT_ID, status: 'active' },
    correlationId: CORRELATION_ID,
    query: {
      roomId: 'room-a',
      startsAt: '2026-09-01T10:00:00.000Z',
      endsAt: '2026-09-01T11:00:00.000Z',
    },
  });

  assert.deepEqual(availability, { available: true, conflictCount: 0 });
  assert.deepEqual(calls.map(([name]) => name), [
    'room-context',
    'entitlement',
    'local',
    'provider',
    'lookup',
  ]);
  assert.equal(calls[2][1].tenantId, TENANT_ID);
  assert.equal(calls[2][1].excludeRequestId, null);
  assert.equal(calls[3][1].tenantId, TENANT_ID);
});
