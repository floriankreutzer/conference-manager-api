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
  semanticChecksum,
  validateDemoFixture,
} from '../src/demo/fixture.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Demo fixture is deterministic, bounded and deeply immutable', () => {
  assert.equal(DEMO_FIXTURE.schemaVersion, 1);
  assert.equal(DEMO_TENANTS.length, 2);
  assert.equal(Object.isFrozen(DEMO_FIXTURE), true);
  assert.equal(Object.isFrozen(DEMO_FIXTURE.tenants[0].settings), true);
  assert.match(DEMO_FIXTURE_CHECKSUM, /^[0-9a-f]{64}$/);
  assert.equal(semanticChecksum(DEMO_FIXTURE), DEMO_FIXTURE_CHECKSUM);
  assert.equal(assertSemanticChecksum(DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM), DEMO_FIXTURE_CHECKSUM);
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
    activatable.providerSimulation.roomMapping.roomId,
    activatable.settings.locations[0].rooms[0].id,
  );
  assert.ok(degraded);
  assert.notEqual(degraded.id, activatable.id);
  assert.equal(degraded.providerSimulation.health, 'degraded');
});

test('customer lookup exposes canonical role unions and provider references for every Tenant', () => {
  for (const tenant of DEMO_TENANTS) {
    for (const persona of ['employee', 'conference_manager', 'tenant_admin']) {
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
  mismatchedMapping.tenants[1].providerSimulation.roomMapping.roomId = 'foreign-room';
  assert.throws(
    () => validateDemoFixture(mismatchedMapping),
    (error) => error.code === 'DEMO_FIXTURE_PROVIDER_INVALID',
  );
});
