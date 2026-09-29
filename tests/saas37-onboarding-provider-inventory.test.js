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
