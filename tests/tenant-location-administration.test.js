import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantLocationAdministrationService } from '../src/application/tenant-location-administration-service.js';
import {
  TenantSettingsConflictError,
} from '../src/application/tenant-settings-errors.js';
import {
  TenantLocationInputError,
  assertTenantLocationTransition,
  normalizeTenantLocations,
  tenantLocationRollbackConfiguration,
} from '../src/domain/tenant-locations.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const principal = Object.freeze({ tenantId: TENANT_ID, userId: USER_ID });
const tenantContext = Object.freeze({ tenantId: TENANT_ID });

function locationConfiguration(overrides = {}) {
  return {
    sites: [{
      id: 'berlin',
      name: 'Berlin',
      active: true,
      timeZone: 'Europe/Berlin',
      address: {
        line1: 'Example 1',
        line2: null,
        postalCode: '10115',
        city: 'Berlin',
        countryCode: 'DE',
      },
    }],
    rooms: [{
      id: 'room-1',
      siteId: 'berlin',
      name: 'Room 1',
      capacity: 12,
      active: true,
      floor: '1',
      equipment: ['display'],
      accessibility: [],
      serviceIds: [],
      cateringPackageIds: [],
      floorplanAssetId: null,
      mediaAssetIds: [],
    }],
    ...overrides,
  };
}

function runtime({ revision = 4 } = {}) {
  const calls = [];
  let currentReads = 0;
  const configuration = locationConfiguration();
  const repository = {
    async current(tenantId) {
      currentReads += 1;
      assert.equal(tenantId, TENANT_ID);
      return {
        revision,
        configuration,
        providerContext: [{
          roomId: 'room-1',
          provider: 'microsoft365',
          status: 'active',
          displayName: 'Provider room',
          capacity: 12,
          lastSeenAt: '2026-08-27T08:00:00.000Z',
        }],
      };
    },
    async update(args) {
      calls.push(args);
      if (args.expectedRevision !== revision) {
        return { status: 'conflict', currentRevision: revision };
      }
      return {
        revision: args.nextRevision,
        configuration: args.configuration,
        providerContext: [],
      };
    },
    async history() { return []; },
    async revision() { return null; },
    async rollback(args) {
      calls.push(args);
      return { revision: args.nextRevision, configuration, providerContext: [] };
    },
  };
  const authorizationPolicy = {
    requireTenantPermission(actualPrincipal, actualTenant) {
      assert.equal(actualPrincipal, principal);
      assert.equal(actualTenant, tenantContext);
    },
  };
  const auditService = {
    createEvent(event) { return { id: 'audit', ...event }; },
    async recordAuthorizationDenied() {},
  };
  return {
    calls,
    currentReads: () => currentReads,
    service: createTenantLocationAdministrationService({
      repository,
      authorizationPolicy,
      auditService,
      clock: () => Date.parse('2026-08-27T08:30:00Z'),
    }),
  };
}

test('location normalization keeps provider authority outside the mutable contract', () => {
  const normalized = normalizeTenantLocations(locationConfiguration(), locationConfiguration());
  assert.equal(normalized.sites[0].timeZone, 'Europe/Berlin');
  assert.equal(normalized.rooms[0].id, 'room-1');
  assert.throws(
    () => normalizeTenantLocations({
      ...locationConfiguration(),
      rooms: [{ ...locationConfiguration().rooms[0], externalRoomId: 'provider-id' }],
    }, locationConfiguration()),
    (error) => error instanceof TenantLocationInputError && error.code === 'TENANT_LOCATIONS_INVALID',
  );
});

test('legacy missing time zones are never fabricated into a writable location snapshot', () => {
  const legacy = locationConfiguration({
    sites: [{ ...locationConfiguration().sites[0], timeZone: null }],
  });
  assert.throws(
    () => normalizeTenantLocations(legacy, legacy),
    (error) => error instanceof TenantLocationInputError
      && error.code === 'TENANT_SITE_TIME_ZONE_INVALID',
  );
});

test('manual rooms cannot be created through the Microsoft-first location contract', () => {
  const current = locationConfiguration();
  const proposed = locationConfiguration({
    rooms: [...current.rooms, { ...current.rooms[0], id: 'manual-room' }],
  });
  assert.throws(
    () => assertTenantLocationTransition(current, proposed),
    (error) => error instanceof TenantLocationInputError
      && error.code === 'TENANT_ROOM_PROVIDER_IMPORT_REQUIRED',
  );
});

test('location service advances revisions and creates audit-bound mutations', async () => {
  const context = runtime({ revision: 4 });
  const { service, calls } = context;
  const result = await service.update({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 4,
    configuration: locationConfiguration(),
  });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.revision, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedRevision, 4);
  assert.equal(calls[0].nextRevision, 5);
  assert.equal(calls[0].auditEvent.metadata.domain, 'locations');
  assert.equal(context.currentReads(), 1);
});

test('stale location writes are decided under the persistence lock and disclose only current revision', async () => {
  const context = runtime({ revision: 7 });
  const { service, calls } = context;
  await assert.rejects(
    service.update({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 6,
      configuration: locationConfiguration(),
    }),
    (error) => error instanceof TenantSettingsConflictError && error.currentRevision === 7,
  );
  assert.equal(calls.length, 1);
  assert.equal(context.currentReads(), 1);
});

test('provider context is read-only presentation data returned beside local configuration', async () => {
  const { service } = runtime();
  const current = await service.getCurrent({ principal, tenantContext, correlationId: CORRELATION_ID });
  assert.equal(current.providerContext[0].provider, 'microsoft365');
  assert.equal(Object.hasOwn(current.providerContext[0], 'externalRoomId'), false);
  assert.equal(Object.hasOwn(current.providerContext[0], 'resourceAddress'), false);
});

test('rollback keeps entities created after the source snapshot present and inactive', () => {
  const source = locationConfiguration();
  const current = locationConfiguration({
    sites: [
      ...source.sites,
      { ...source.sites[0], id: 'munich', name: 'Munich' },
    ],
    rooms: [
      ...source.rooms,
      { ...source.rooms[0], id: 'room-2', siteId: 'munich', name: 'Room 2' },
    ],
  });
  const rollback = tenantLocationRollbackConfiguration(current, source);
  assert.deepEqual(rollback.sites.map(({ id, active }) => ({ id, active })), [
    { id: 'berlin', active: true },
    { id: 'munich', active: false },
  ]);
  assert.deepEqual(rollback.rooms.map(({ id, active }) => ({ id, active })), [
    { id: 'room-1', active: true },
    { id: 'room-2', active: false },
  ]);
});

test('rollback cannot restore a legacy snapshot with an unknown Site time zone', () => {
  const current = locationConfiguration();
  const legacySource = locationConfiguration({
    sites: [{ ...locationConfiguration().sites[0], timeZone: null }],
  });
  assert.throws(
    () => tenantLocationRollbackConfiguration(current, legacySource),
    (error) => error instanceof TenantLocationInputError
      && error.code === 'TENANT_SITE_TIME_ZONE_INVALID',
  );
});

test('location asset references are opaque identifiers and never browser-controlled URLs', () => {
  const configuration = locationConfiguration({
    rooms: [{
      ...locationConfiguration().rooms[0],
      floorplanAssetId: 'https://attacker.invalid/floorplan',
    }],
  });
  assert.throws(
    () => normalizeTenantLocations(configuration),
    (error) => error instanceof TenantLocationInputError
      && error.code === 'TENANT_ROOM_FLOORPLAN_INVALID',
  );
});
