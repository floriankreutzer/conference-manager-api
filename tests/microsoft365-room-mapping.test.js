import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import {
  createMicrosoft365RoomMappingService,
} from '../src/application/microsoft365-room-mapping-service.js';

const TENANT_ID = '61616161-6161-4161-8161-616161616161';
const USER_ID = '62626262-6262-4262-8262-626262626262';
const INTEGRATION_ID = '63636363-6363-4363-8363-636363636363';
const ROOM_ID = '64646464-6464-4464-8464-646464646464';
const CORRELATION_ID = '65656565-6565-4565-8565-656565656565';
const SITE_ID = 'site-a';

function principal() {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ['tenant_admin'],
    permissions: ['tenant:configure', 'tenant:integrations:manage'],
  };
}

function discoveredRoom(overrides = {}) {
  return {
    externalRoomId: 'provider-room-1',
    displayName: 'Provider Room',
    resourceAddress: 'provider-room@example.invalid',
    capacity: 12,
    ...overrides,
  };
}

function serviceFixture({
  rooms = [discoveredRoom()],
  siteIds = new Set([SITE_ID]),
  authorize = () => true,
} = {}) {
  const imports = [];
  const audits = [];
  const mappingRepository = {
    listByTenantIdAndIntegrationId: async () => [],
    existingSiteIds: async () => siteIds,
    importRooms: async (value) => {
      imports.push(value);
      return value.rooms.map((room) => ({
        tenantId: value.tenantId,
        integrationId: value.integrationId,
        externalRoomId: room.externalRoomId,
        resourceAddress: room.resourceAddress,
        providerDisplayName: room.providerDisplayName,
        providerCapacity: room.providerCapacity,
        providerStatus: 'active',
        lastSeenAt: value.changedAt.toISOString(),
        roomId: room.roomId,
        localRoom: {
          id: room.roomId,
          siteId: room.siteId,
          name: room.localName,
          capacity: room.localCapacity,
          active: true,
        },
      }));
    },
    synchronize: async () => [],
  };
  const auditService = {
    createEvent: (value) => value,
    recordAuthorizationDenied: async (value) => audits.push(value),
  };
  const service = createMicrosoft365RoomMappingService({
    mappingRepository,
    connectionRepository: {
      findByTenantId: async () => ({
        integrationId: INTEGRATION_ID,
        status: 'connected',
        placesPermission: 'granted',
      }),
    },
    discoveryService: { discoverRooms: async () => rooms },
    authorizationPolicy: { requireTenantPermission: authorize },
    auditService,
    clock: () => Date.parse('2026-08-25T15:00:00.000Z'),
    idFactory: () => ROOM_ID,
  });
  return { service, imports, audits };
}

test('selected discovered room imports with explicit local ownership values and no client tenant authority', async () => {
  const { service, imports } = serviceFixture();
  const result = await service.importSelectedRooms({
    principal: principal(),
    tenantContext: { tenantId: TENANT_ID },
    correlationId: CORRELATION_ID,
    selections: [{
      externalRoomId: 'provider-room-1',
      siteId: SITE_ID,
      name: 'Local Boardroom',
      capacity: 20,
    }],
  });

  assert.equal(result.length, 1);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].tenantId, TENANT_ID);
  assert.equal(imports[0].integrationId, INTEGRATION_ID);
  assert.deepEqual(imports[0].rooms[0], {
    roomId: ROOM_ID,
    siteId: SITE_ID,
    localName: 'Local Boardroom',
    localCapacity: 20,
    externalRoomId: 'provider-room-1',
    resourceAddress: 'provider-room@example.invalid',
    providerDisplayName: 'Provider Room',
    providerCapacity: 12,
  });
  assert.equal('tenantId' in result[0], false);
  assert.equal('integrationId' in result[0], false);
});

test('import fails closed when the selected provider room was not discovered for the authenticated tenant', async () => {
  const { service, imports } = serviceFixture({ rooms: [] });
  await assert.rejects(
    () => service.importSelectedRooms({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      selections: [{ externalRoomId: 'provider-room-1', siteId: SITE_ID, capacity: 10 }],
    }),
    (error) => error.code === 'MICROSOFT365_ROOM_NOT_DISCOVERED',
  );
  assert.equal(imports.length, 0);
});

test('import rejects a site that is not owned by the authenticated tenant before persistence', async () => {
  const { service, imports } = serviceFixture({ siteIds: new Set() });
  await assert.rejects(
    () => service.importSelectedRooms({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      selections: [{ externalRoomId: 'provider-room-1', siteId: SITE_ID, capacity: 10 }],
    }),
    (error) => error.code === 'MICROSOFT365_ROOM_SITE_INVALID',
  );
  assert.equal(imports.length, 0);
});

test('provider rooms without capacity require an explicit local Conference Manager capacity', async () => {
  const { service, imports } = serviceFixture({ rooms: [discoveredRoom({ capacity: null })] });
  await assert.rejects(
    () => service.importSelectedRooms({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      selections: [{ externalRoomId: 'provider-room-1', siteId: SITE_ID }],
    }),
    (error) => error.code === 'MICROSOFT365_ROOM_CAPACITY_REQUIRED',
  );
  assert.equal(imports.length, 0);
});

test('authorization denial is audited before provider discovery or persistence', async () => {
  const denial = new AuthorizationDeniedError('PERMISSION_REQUIRED');
  const { service, imports, audits } = serviceFixture({
    authorize: () => { throw denial; },
  });
  await assert.rejects(
    () => service.importSelectedRooms({
      principal: principal(),
      tenantContext: { tenantId: TENANT_ID },
      correlationId: CORRELATION_ID,
      selections: [{ externalRoomId: 'provider-room-1', siteId: SITE_ID, capacity: 10 }],
    }),
    (error) => error === denial,
  );
  assert.equal(imports.length, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].tenantContext.tenantId, TENANT_ID);
  assert.equal(audits[0].metadata.operation, 'room_import');
});
