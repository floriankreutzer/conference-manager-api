import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMO_FIXTURE,
  DEMO_FIXTURE_CHECKSUM,
  semanticChecksum,
} from '../src/demo/fixture.js';
import {
  readDemoSemanticState,
  seedDemoBusinessState,
} from '../src/persistence/postgres/demo-fixture-state.js';

test('concrete Demo seeder uses bounded named parameterized writes and never seeds sessions', async () => {
  const queries = [];
  await seedDemoBusinessState({
    fixture: DEMO_FIXTURE,
    async refreshProjections(client, input) {
      assert.equal(typeof client.query, 'function');
      assert.deepEqual(input, {
        limit: DEMO_FIXTURE.tenants.length,
        observedAt: DEMO_FIXTURE.fixedClock,
      });
      return { refreshedCount: DEMO_FIXTURE.tenants.length };
    },
    client: {
      async query(query) {
        queries.push(query);
        return { rowCount: 1, rows: [] };
      },
    },
  });
  assert.equal(queries.length > 20, true);
  assert.equal(queries.every(({ name, values }) => typeof name === 'string' && Array.isArray(values)), true);
  assert.equal(queries.some(({ name }) => name.includes('session')), false);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-tenant').length, 2);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-user').length, 6);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-platform-operator').length, 4);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-room').length, 2);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-room-price').length, 2);
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-identity-binding').length, 2);
  assert.equal(
    queries.filter(({ name }) => name === 'demo-fixture-insert-microsoft365-integration').length,
    2,
  );
  assert.equal(
    queries.filter(({ name }) => name === 'demo-fixture-insert-microsoft365-room-mapping').length,
    2,
  );
  assert.equal(queries.filter(({ name }) => name === 'demo-fixture-insert-microsoft365-health').length, 6);
  const readyTenant = DEMO_FIXTURE.tenants.find(({ lifecycleStatus }) => lifecycleStatus === 'ready');
  const readyIntegration = queries.find(({ name, values }) => (
    name === 'demo-fixture-insert-microsoft365-integration' && values[0] === readyTenant.id
  ));
  const readyMapping = queries.find(({ name, values }) => (
    name === 'demo-fixture-insert-microsoft365-room-mapping' && values[0] === readyTenant.id
  ));
  const readyHealth = queries.filter(({ name, values }) => (
    name === 'demo-fixture-insert-microsoft365-health' && values[0] === readyTenant.id
  ));
  assert.deepEqual(readyIntegration.values.slice(2, 7), [
    readyTenant.providerSimulation.providerTenantReference,
    'connected',
    DEMO_FIXTURE.fixedClock,
    'granted',
    'granted',
  ]);
  assert.equal(readyMapping.values[1], readyTenant.providerSimulation.roomMapping.roomId);
  assert.deepEqual(readyHealth.map(({ values }) => values.slice(2, 5)), [
    ['places', 'healthy', null],
    ['free_busy', 'healthy', null],
    ['calendar_write', 'healthy', null],
  ]);
  assert.deepEqual(
    queries
      .filter(({ name }) => name === 'demo-fixture-insert-platform-operator')
      .map(({ values }) => values[6]),
    DEMO_FIXTURE.platform.personas.map(({ securityVersion, tenantIds }) => (
      securityVersion - tenantIds.length
    )),
  );
  for (const persona of DEMO_FIXTURE.platform.personas) {
    const initialVersion = persona.securityVersion - persona.tenantIds.length;
    assert.equal(initialVersion + persona.tenantIds.length, persona.securityVersion);
  }
});

test('semantic reader reconstructs the exact source fixture from canonical PostgreSQL projections', async () => {
  const byName = {
    'demo-fixture-read-tenants': DEMO_FIXTURE.tenants.map((tenant) => ({
      id: tenant.id,
      display_name: tenant.displayName,
      status: tenant.lifecycleStatus,
      lifecycle_revision: tenant.lifecycleRevision,
      created_at: DEMO_FIXTURE.fixedClock,
      legal_name: tenant.settings.organization.name,
      country_code: tenant.settings.organization.countryCode,
      default_currency: tenant.settings.catalogue.currency,
    })),
    'demo-fixture-read-sites': DEMO_FIXTURE.tenants.flatMap((tenant) => tenant.settings.locations.map((location) => ({
      tenant_id: tenant.id,
      id: location.id,
      name: location.name,
    }))),
    'demo-fixture-read-rooms': DEMO_FIXTURE.tenants.flatMap((tenant) => (
      tenant.settings.locations.flatMap((location) => location.rooms.map((room) => ({
        tenant_id: tenant.id,
        site_id: location.id,
        id: room.id,
        name: room.name,
        capacity: room.capacity,
        price_minor: room.priceMinor,
      })))
    )),
    'demo-fixture-read-services': DEMO_FIXTURE.tenants.flatMap((tenant) => (
      tenant.settings.catalogue.services.map((id) => ({
        tenant_id: tenant.id,
        id,
        currency: tenant.settings.catalogue.currency,
      }))
    )),
    'demo-fixture-read-requests': DEMO_FIXTURE.tenants.flatMap((tenant) => tenant.requests.map((request) => ({
      tenant_id: tenant.id,
      id: request.id,
      requester_user_id: request.requesterUserId,
      room_id: request.roomId,
      status: request.status,
      starts_at: request.startsAt,
      ends_at: request.endsAt,
      internal_participants: request.internalParticipants,
      external_participants: request.externalParticipants,
    }))),
    'demo-fixture-read-providers': DEMO_FIXTURE.tenants.map((tenant) => ({
      tenant_id: tenant.id,
      provider: tenant.providerSimulation.provider,
      identity_binding_id: tenant.providerSimulation.identityBindingId,
      integration_id: tenant.providerSimulation.integrationId,
      provider_tenant_reference: tenant.providerSimulation.providerTenantReference,
      connection_state: tenant.providerSimulation.connectionState,
      places_permission_status: tenant.providerSimulation.placesPermission,
      calendars_permission_status: tenant.providerSimulation.calendarsPermission,
      health: tenant.providerSimulation.health,
      scenario: tenant.providerSimulation.scenario,
      room_id: tenant.providerSimulation.roomMapping.roomId,
      external_room_id: tenant.providerSimulation.roomMapping.externalRoomId,
      resource_address: tenant.providerSimulation.roomMapping.resourceAddress,
    })),
    'demo-fixture-read-customer-personas': DEMO_FIXTURE.customerPersonas.map((persona) => ({
      context_key: `${persona.tenantId}:${persona.persona}`,
      tenant_id: persona.tenantId,
      persona: persona.persona,
      user_id: persona.userId,
      provider: persona.providerIdentity.provider,
      provider_subject_reference: persona.providerIdentity.reference,
      security_version: persona.securityVersion,
      elevated_roles: persona.roles.filter((role) => role !== 'employee'),
    })),
    'demo-fixture-read-platform-personas': DEMO_FIXTURE.platform.personas.map((persona) => ({
      persona: persona.persona,
      operator_id: persona.operatorId,
      provider: persona.providerIdentity.provider,
      provider_tenant_reference: persona.providerIdentity.tenantReference,
      provider_subject_reference: persona.providerIdentity.subjectReference,
      assurance_level: persona.assurance.level,
      authentication_context: persona.assurance.authenticationContext,
      roles: persona.roles,
      security_version: persona.securityVersion,
      scope_mode: persona.targetScope.mode,
      tenant_ids: persona.tenantIds,
    })),
    'demo-fixture-read-platform-deployment': [{
      id: DEMO_FIXTURE.platform.deployment.id,
      environment: DEMO_FIXTURE.platform.deployment.environment,
      deployment_reference: DEMO_FIXTURE.platform.deployment.deploymentReference,
      schema_current_version: DEMO_FIXTURE.platform.deployment.schemaVersion,
      required_dependencies_state: DEMO_FIXTURE.platform.deployment.requiredDependenciesState,
      optional_dependencies_state: DEMO_FIXTURE.platform.deployment.optionalDependenciesState,
    }],
    'demo-fixture-read-platform-metering': DEMO_FIXTURE.platform.metering.map((period) => ({
      tenant_id: period.tenantId,
      period_start: `${period.period}-01T00:00:00.000Z`,
      requests_created: period.requestCount,
    })),
  };
  const state = await readDemoSemanticState({
    client: {
      async query({ name }) {
        return { rows: byName[name] };
      },
    },
  });
  assert.equal(semanticChecksum(state), DEMO_FIXTURE_CHECKSUM);
});
