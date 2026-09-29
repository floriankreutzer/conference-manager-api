import assert from 'node:assert/strict';
import test from 'node:test';
import { demoProviderRooms } from '../src/demo/customer-composition.js';
import { DEMO_FIXTURE } from '../src/demo/fixture.js';

const FABRIKAM = '40000000-0000-4000-8000-000000000004';

test('Fabrikam starts empty but has tenant-owned simulated provider candidates to import', () => {
  const tenant = DEMO_FIXTURE.tenants.find(({ id }) => id === FABRIKAM);
  assert.ok(tenant);
  assert.equal(tenant.settings.locations.flatMap(({ rooms }) => rooms).length, 0);
  assert.equal(tenant.providerSimulation.roomMappings.length, 0);
  const inventory = demoProviderRooms()[tenant.providerSimulation.providerTenantReference];
  assert.ok(inventory.length > 0, 'Onboarding discovery must not depend on already imported local rooms');
  assert.ok(inventory.length <= 100);
  assert.equal(new Set(inventory.map(({ id }) => id)).size, inventory.length);
  assert.equal(Object.isFrozen(inventory), true);
});

test('the fully configured Northwind scenario can actually perform a new booking', async () => {
  const { createDemoMicrosoft365Client } = await import('../src/demo/provider/microsoft365-client.js');
  const tenant = DEMO_FIXTURE.tenants.find(({ id }) => id === '10000000-0000-4000-8000-000000000001');
  const reference = tenant.providerSimulation.providerTenantReference;
  const provider = createDemoMicrosoft365Client({
    publicOrigin: 'https://customer.demo.test:4443',
    roomsByTenantReference: demoProviderRooms(),
    scenarioByTenantReference: { [reference]: tenant.providerSimulation.scenario },
  });
  const room = tenant.providerSimulation.roomMappings[0];
  assert.deepEqual(await provider.lookupFreeBusy({
    tenantReference: reference,
    schedules: [room.resourceAddress],
    startsAt: '2099-01-05T10:00:00.000Z',
    endsAt: '2099-01-05T11:00:00.000Z',
  }), [{ schedule: room.resourceAddress, available: true, conflictCount: 0 }]);
});

test('unimported provider candidates are immutable, tenant-isolated and independent of reset generation', async () => {
  const { demoOnboardingProviderRooms } = await import('../src/demo/provider/onboarding-room-inventory.js');
  const first = demoProviderRooms();
  assert.deepEqual(first[FABRIKAM].map(({ id }) => id), ['fabrikam-workshop', 'fabrikam-focus']);
  for (const value of [null, undefined, '', '10000000-0000-4000-8000-000000000001', 'unknown']) {
    assert.deepEqual(demoOnboardingProviderRooms(value), []);
  }
  assert.throws(() => { first[FABRIKAM][0].capacity = 999; }, TypeError);
  for (const [tenantId, rooms] of Object.entries(first)) {
    if (tenantId === FABRIKAM) continue;
    assert.ok(rooms.every(({ id }) => !id.startsWith('fabrikam-')));
  }
  assert.deepEqual(demoProviderRooms(), first);
  assert.equal(DEMO_FIXTURE.tenants.find(({ id }) => id === FABRIKAM).settings.locations.length, 0);
});

test('degraded simulation still rejects discovery, availability and booking instead of silently succeeding', async () => {
  const { createDemoMicrosoft365Client } = await import('../src/demo/provider/microsoft365-client.js');
  const provider = createDemoMicrosoft365Client({
    publicOrigin: 'https://customer.demo.test:4443',
    roomsByTenantReference: demoProviderRooms(),
    scenarioByTenantReference: { [FABRIKAM]: 'provider_degraded' },
  });
  const expected = (error) => error.code === 'MICROSOFT365_GRAPH_UNAVAILABLE';
  await assert.rejects(provider.discoverRooms({ tenantReference: FABRIKAM }), expected);
  const query = {
    tenantReference: FABRIKAM,
    startsAt: '2099-01-05T10:00:00.000Z',
    endsAt: '2099-01-05T11:00:00.000Z',
  };
  await assert.rejects(provider.lookupFreeBusy({ ...query, schedules: ['fabrikam-workshop@example.invalid'] }), expected);
  await assert.rejects(provider.createCalendarEvent({
    ...query, resourceAddress: 'fabrikam-workshop@example.invalid', idempotencyKey: 'a'.repeat(64),
  }), expected);
});
