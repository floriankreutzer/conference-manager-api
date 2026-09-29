import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_CUSTOMER_PERSONAS_BY_CONTEXT,
  DEMO_FIXTURE,
  DEMO_FIXTURE_CHECKSUM,
  DEMO_PLATFORM_PERSONAS_BY_NAME,
  DEMO_TENANTS,
  DemoFixtureError,
  assertSemanticChecksum,
  customerPersonaKey,
  createDemoResetGenerationFixture,
  semanticChecksum,
  validateDemoFixture,
} from '../src/demo/fixture.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Demo fixture is deterministic, bounded and deeply immutable', () => {
  assert.equal(DEMO_FIXTURE.schemaVersion, 1);
  assert.equal(DEMO_TENANTS.length, 3);
  assert.equal(Object.isFrozen(DEMO_FIXTURE), true);
  assert.equal(Object.isFrozen(DEMO_FIXTURE.tenants[0].settings), true);
  assert.match(DEMO_FIXTURE_CHECKSUM, /^[0-9a-f]{64}$/);
  assert.equal(semanticChecksum(DEMO_FIXTURE), DEMO_FIXTURE_CHECKSUM);
  assert.equal(assertSemanticChecksum(DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM), DEMO_FIXTURE_CHECKSUM);
});

test('reset generation keeps local booking hours across daylight saving and changes the semantic digest', () => {
  const before = createDemoResetGenerationFixture(DEMO_FIXTURE, new Date('2026-10-12T12:00:00.000Z'));
  const after = createDemoResetGenerationFixture(DEMO_FIXTURE, new Date('2026-10-26T12:00:00.000Z'));
  assert.equal(before.fixedClock, '2026-10-12T12:00:00.000Z');
  assert.equal(after.fixedClock, '2026-10-26T12:00:00.000Z');
  const first = before.tenants[0].requests[0];
  const later = after.tenants[0].requests[0];
  assert.equal(first.startsAt, '2026-10-20T07:00:00.000Z');
  assert.equal(later.startsAt, '2026-11-03T08:00:00.000Z');
  assert.equal(before.tenants[1].requests[0].startsAt, '2026-10-21T08:00:00.000Z');
  assert.equal(after.tenants[1].requests[0].startsAt, '2026-11-04T09:00:00.000Z');
  assert.equal(Date.parse(first.endsAt) - Date.parse(first.startsAt), 120 * 60 * 1000);
  assert.notEqual(semanticChecksum(before), semanticChecksum(after));
  assert.equal(semanticChecksum(DEMO_FIXTURE), DEMO_FIXTURE_CHECKSUM);
});

test('fixture provides one activatable Tenant and an isolated degraded-provider Tenant', () => {
  const activatable = DEMO_FIXTURE.tenants.find(({ lifecycleStatus }) => lifecycleStatus === 'ready');
  const degraded = DEMO_FIXTURE.tenants.find(({ providerSimulation }) => (
    providerSimulation.scenario === 'provider_degraded'
  ));
  assert.ok(activatable);
  assert.equal(activatable.providerSimulation.connectionState, 'connected');
  assert.equal(activatable.providerSimulation.placesPermission, 'granted');
  assert.equal(activatable.providerSimulation.calendarsPermission, 'granted');
  assert.equal(activatable.providerSimulation.health, 'healthy');
  assert.equal(activatable.providerSimulation.scenario, 'booking_success');
  assert.equal(activatable.settings.locations[0].rooms.length > 0, true);
  assert.equal(
    activatable.providerSimulation.roomMappings[0].roomId,
    activatable.settings.locations[0].rooms[0].id,
  );
  assert.ok(degraded);
  assert.notEqual(degraded.id, activatable.id);
  assert.equal(degraded.providerSimulation.health, 'degraded');
});

test('customer lookup exposes canonical role unions and provider references for every Tenant', () => {
  for (const tenant of DEMO_TENANTS) {
    const personas = tenant.lifecycleStatus === 'onboarding'
      ? ['tenant_admin'] : ['employee', 'conference_manager', 'tenant_admin'];
    for (const persona of personas) {
      const selection = DEMO_CUSTOMER_PERSONAS_BY_CONTEXT[customerPersonaKey(tenant.id, persona)];
      assert.equal(selection.tenantId, tenant.id);
      assert.equal(selection.persona, persona);
      assert.equal(selection.roles[0], 'employee');
      assert.equal(Number.isSafeInteger(selection.securityVersion), true);
      assert.match(selection.userId, /^[0-9a-f-]{36}$/);
      assert.equal(selection.providerIdentity.provider, 'demo_customer');
      assert.deepEqual(Object.keys(selection.providerIdentity).sort(), ['provider', 'reference']);
    }
  }
});

test('platform lookup stores roles but leaves permission derivation to the canonical policy', () => {
  assert.deepEqual(Object.keys(DEMO_PLATFORM_PERSONAS_BY_NAME).sort(), [
    'security_admin',
    'security_auditor',
    'support_reader',
    'tenant_operator',
  ]);
  for (const persona of Object.values(DEMO_PLATFORM_PERSONAS_BY_NAME)) {
    assert.equal(Object.hasOwn(persona, 'permissions'), false);
    assert.equal(permissionsForPlatformRoles(persona.roles).length > 0, true);
    assert.equal(['all', 'allowlist'].includes(persona.targetScope.mode), true);
    assert.equal(persona.providerIdentity.provider, 'demo_platform');
    assert.deepEqual(Object.keys(persona.providerIdentity).sort(), [
      'provider',
      'subjectReference',
      'tenantReference',
    ]);
    assert.match(persona.operatorId, /^[0-9a-f-]{36}$/);
  }
});

test('semantic checksum ignores object key order but detects semantic changes', () => {
  assert.equal(semanticChecksum({ second: 2, first: 1 }), semanticChecksum({ first: 1, second: 2 }));
  assert.notEqual(semanticChecksum({ first: 1 }), semanticChecksum({ first: 2 }));
  assert.throws(
    () => assertSemanticChecksum({ first: 2 }, semanticChecksum({ first: 1 })),
    (error) => error instanceof DemoFixtureError && error.code === 'DEMO_FIXTURE_CHECKSUM_MISMATCH',
  );
});

test('fixture schema rejects unknown fields, duplicate Tenants and incorrect permissions', () => {
  const unknown = clone(DEMO_FIXTURE);
  unknown.unapproved = true;
  assert.throws(() => validateDemoFixture(unknown), DemoFixtureError);

  const duplicate = clone(DEMO_FIXTURE);
  duplicate.tenants[1].id = duplicate.tenants[0].id;
  duplicate.tenants[1].providerSimulation.providerTenantReference = duplicate.tenants[0].id;
  assert.throws(
    () => validateDemoFixture(duplicate),
    (error) => error.code === 'DEMO_FIXTURE_TENANT_DUPLICATE',
  );

  const permissions = clone(DEMO_FIXTURE);
  permissions.customerPersonas[0].permissions.push('tenant:configure');
  assert.throws(
    () => validateDemoFixture(permissions),
    (error) => error.code === 'DEMO_FIXTURE_CUSTOMER_PERMISSION_INVALID',
  );

  const mismatchedMapping = clone(DEMO_FIXTURE);
  mismatchedMapping.tenants[1].providerSimulation.roomMappings[0].roomId = 'foreign-room';
  assert.throws(
    () => validateDemoFixture(mismatchedMapping),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );
});

function incompleteOnboardingFixture() {
  const candidate = clone(DEMO_FIXTURE);
  const tenant = candidate.tenants[1];
  tenant.lifecycleStatus = 'onboarding';
  tenant.settings.organization.name = null;
  tenant.settings.locations = [];
  tenant.settings.catalogue.services = [];
  tenant.settings.catalogue.equipment = [];
  tenant.requests = [];
  tenant.roomMedia = [];
  tenant.catalogueMedia = [];
  tenant.providerSimulation.connectionState = 'pending';
  tenant.providerSimulation.placesPermission = 'missing';
  tenant.providerSimulation.calendarsPermission = 'missing';
  tenant.providerSimulation.health = 'unknown';
  tenant.providerSimulation.scenario = 'onboarding';
  tenant.providerSimulation.roomMappings = [];
  return candidate;
}

test('fixture accepts a genuinely empty, unconnected onboarding Tenant', () => {
  const candidate = incompleteOnboardingFixture();
  assert.equal(validateDemoFixture(candidate), candidate);
  assert.notEqual(semanticChecksum(candidate), DEMO_FIXTURE_CHECKSUM);
});

test('fixture rejects ready empty Tenants and inconsistent onboarding provider state', () => {
  const readyWithoutRooms = incompleteOnboardingFixture();
  readyWithoutRooms.tenants[1].lifecycleStatus = 'ready';
  assert.throws(
    () => validateDemoFixture(readyWithoutRooms),
    (error) => error.code === 'DEMO_FIXTURE_SETTINGS_INVALID',
  );

  const connectedOnboarding = incompleteOnboardingFixture();
  connectedOnboarding.tenants[1].providerSimulation.connectionState = 'connected';
  assert.throws(
    () => validateDemoFixture(connectedOnboarding),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );

  const mappedOnboarding = incompleteOnboardingFixture();
  mappedOnboarding.tenants[1].providerSimulation.roomMappings = [{
    roomId: 'northwind-berlin-room-1',
    externalRoomId: 'foreign-room',
    resourceAddress: 'foreign-room@example.invalid',
  }];
  assert.throws(
    () => validateDemoFixture(mappedOnboarding),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );

  const populatedOnboarding = incompleteOnboardingFixture();
  populatedOnboarding.tenants[1].settings.locations = clone(DEMO_FIXTURE.tenants[1].settings.locations);
  assert.throws(
    () => validateDemoFixture(populatedOnboarding),
    (error) => error.code === 'DEMO_FIXTURE_SETTINGS_INVALID',
  );
});

test('each additional bookable room requires a distinct same-Tenant provider mapping', () => {
  const candidate = clone(DEMO_FIXTURE);
  const tenant = candidate.tenants[0];
  const mapping = tenant.providerSimulation.roomMappings.pop();
  assert.throws(
    () => validateDemoFixture(candidate),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );
  tenant.providerSimulation.roomMappings.push(mapping);
  assert.equal(validateDemoFixture(candidate), candidate);
  tenant.providerSimulation.roomMappings.at(-1).roomId = tenant.providerSimulation.roomMappings[0].roomId;
  assert.throws(
    () => validateDemoFixture(candidate),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );
});
