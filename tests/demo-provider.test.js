import assert from 'node:assert/strict';
import test from 'node:test';

import { demoProviderRooms } from '../src/demo/customer-composition.js';
import { DEMO_FIXTURE } from '../src/demo/fixture.js';
import { createDemoMicrosoft365Client } from '../src/demo/provider/microsoft365-client.js';
import { Microsoft365ProviderError } from '../src/integrations/microsoft365-contract.js';

const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000002';
const WINDOW = Object.freeze({
  startsAt: '2026-09-01T10:00:00.000Z',
  endsAt: '2026-09-01T11:00:00.000Z',
});

function client() {
  return createDemoMicrosoft365Client({
    publicOrigin: 'https://customer.demo.invalid',
    roomsByTenantReference: {
      [TENANT_A]: [{
        id: 'northwind-room-1',
        displayName: 'Northwind Demo Room',
        resourceAddress: 'northwind-room-1@demo.invalid',
        capacity: 12,
      }],
    },
    scenarioByTenantReference: {
      [TENANT_A]: 'booking_success',
      [TENANT_B]: 'provider_degraded',
    },
  });
}

test('Demo provider is deterministic, provider-shaped, and performs no outbound request', async () => {
  const provider = client();
  assert.deepEqual(await provider.discoverRooms({ tenantReference: TENANT_A }), [{
    externalRoomId: 'northwind-room-1',
    displayName: 'Northwind Demo Room',
    resourceAddress: 'northwind-room-1@demo.invalid',
    capacity: 12,
    building: null,
    floorNumber: null,
    floorLabel: null,
    label: null,
    nickname: null,
    phone: null,
    audioDeviceName: null,
    videoDeviceName: null,
    displayDeviceName: null,
    bookingType: null,
  }]);
  assert.deepEqual(await provider.lookupFreeBusy({
    tenantReference: TENANT_A,
    schedules: ['northwind-room-1@demo.invalid'],
    ...WINDOW,
  }), [{ schedule: 'northwind-room-1@demo.invalid', available: true, conflictCount: 0 }]);
  const input = {
    tenantReference: TENANT_A,
    resourceAddress: 'northwind-room-1@demo.invalid',
    idempotencyKey: 'a'.repeat(64),
    ...WINDOW,
  };
  assert.deepEqual(await provider.createCalendarEvent(input), {
    providerReference: `demo-event-${'a'.repeat(32)}`,
    disposition: 'created',
  });
  assert.deepEqual(await provider.createCalendarEvent(input), await provider.createCalendarEvent(input));
});

test('Customer Demo composition derives provider inventory from every mapped fixture room', () => {
  const inventory = demoProviderRooms();
  assert.deepEqual(
    Object.keys(inventory).sort(),
    DEMO_FIXTURE.tenants.map(({ providerSimulation }) => (
      providerSimulation.providerTenantReference
    )).sort(),
  );
  for (const tenant of DEMO_FIXTURE.tenants) {
    const mapping = tenant.providerSimulation.roomMapping;
    const location = tenant.settings.locations.find(({ rooms }) => (
      rooms.some(({ id }) => id === mapping.roomId)
    ));
    const room = location.rooms.find(({ id }) => id === mapping.roomId);
    assert.deepEqual(inventory[tenant.providerSimulation.providerTenantReference], [{
      id: mapping.externalRoomId,
      displayName: room.name,
      resourceAddress: mapping.resourceAddress,
      capacity: room.capacity,
      building: location.name,
    }]);
  }
});

test('Demo provider exposes explicit degradation and validates caller-controlled inputs', async () => {
  const provider = client();
  assert.deepEqual(await provider.verifyBasePermissions({ tenantReference: TENANT_B }), {
    status: 'degraded',
    places: 'unknown',
    calendars: 'unknown',
    reason: 'provider_unavailable',
  });
  await assert.rejects(
    provider.lookupFreeBusy({
      tenantReference: TENANT_B,
      schedules: ['contoso-room-1@demo.invalid'],
      ...WINDOW,
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_GRAPH_UNAVAILABLE',
  );
  await assert.rejects(
    provider.lookupFreeBusy({
      tenantReference: TENANT_A,
      schedules: ['invalid resource'],
      ...WINDOW,
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_GRAPH_REQUEST_INVALID',
  );
});
