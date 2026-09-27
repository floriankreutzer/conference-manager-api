import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantLocationAdministrationService } from '../src/application/tenant-location-administration-service.js';
import {
  TenantSettingsConflictError,
} from '../src/application/tenant-settings-errors.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { PERMISSION } from '../src/authorization/policy.js';
import {
  TenantLocationInputError,
  assertTenantLocationTransition,
  normalizeTenantLocations, normalizeStoredTenantLocations, normalizeTenantLocationsV2,
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

function runtime({
  revision = 4,
  lockedRevision = revision,
  configuration = locationConfiguration(),
  sourceConfiguration = locationConfiguration(),
  deniedPermissions = [],
} = {}) {
  const calls = [];
  const permissionChecks = [];
  const authorizationDenials = [];
  const committedAuditEvents = [];
  let commits = 0;
  let currentReads = 0;
  let revisionReads = 0;
  let transitionAuthorizations = 0;
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
      if (args.expectedRevision !== lockedRevision) {
        return { status: 'conflict', currentRevision: lockedRevision };
      }
      transitionAuthorizations += 1;
      args.assertAuthorizedTransition(configuration, args.configuration);
      commits += 1;
      committedAuditEvents.push(args.auditEvent);
      return {
        revision: args.nextRevision,
        configuration: args.configuration,
        providerContext: [],
      };
    },
    async history() { return []; },
    async revision() {
      revisionReads += 1;
      return { revision: 1, configuration: sourceConfiguration };
    },
    async rollback(args) {
      calls.push(args);
      if (args.expectedRevision !== lockedRevision) {
        return { status: 'conflict', currentRevision: lockedRevision };
      }
      const proposed = tenantLocationRollbackConfiguration(configuration, sourceConfiguration);
      transitionAuthorizations += 1;
      args.assertAuthorizedTransition(configuration, proposed);
      commits += 1;
      committedAuditEvents.push(args.auditEvent);
      return {
        revision: args.nextRevision,
        configuration: proposed,
        providerContext: [],
      };
    },
  };
  const authorizationPolicy = {
    requireTenantPermission(actualPrincipal, actualTenant, permission) {
      assert.equal(actualPrincipal, principal);
      assert.equal(actualTenant, tenantContext);
      permissionChecks.push(permission);
      if (deniedPermissions.includes(permission)) {
        throw new AuthorizationDeniedError('PERMISSION_REQUIRED');
      }
      return true;
    },
  };
  const auditService = {
    createEvent(event) { return { id: 'audit', ...event }; },
    async recordAuthorizationDenied(event) { authorizationDenials.push(event); },
  };
  return {
    authorizationDenials,
    calls,
    committedAuditEvents,
    commits: () => commits,
    currentReads: () => currentReads,
    permissionChecks,
    revisionReads: () => revisionReads,
    transitionAuthorizations: () => transitionAuthorizations,
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

test('legacy Room wayfinding remains readable but new writes cannot publish unsafe guest text', () => {
  const old = locationConfiguration({
    rooms: [{ ...locationConfiguration().rooms[0], floor: 'Door code 1234',
      accessibility: ['https://internal.example.test/entry'] }],
  });
  const stored = normalizeStoredTenantLocations(old);
  assert.equal(stored.rooms[0].floor, 'Door code 1234');
  assert.deepEqual(stored.rooms[0].accessibility, ['https://internal.example.test/entry']);
  assert.equal(normalizeTenantLocationsV2({
    sites: old.sites.map((site) => ({ ...site, guestInformation: null })), rooms: old.rooms,
  }, { stored: true }).rooms[0].floor, 'Door code 1234');
  assert.throws(() => normalizeTenantLocations(old),
    (error) => error instanceof TenantLocationInputError && error.code === 'TENANT_ROOM_FLOOR_INVALID');
  assert.throws(() => normalizeTenantLocationsV2({
    sites: old.sites.map((site) => ({ ...site, guestInformation: null })), rooms: old.rooms,
  }), (error) => error instanceof TenantLocationInputError && error.code === 'TENANT_ROOM_FLOOR_INVALID');
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
  assert.equal(context.commits(), 1);
  assert.equal(context.transitionAuthorizations(), 1);
  assert.equal(context.currentReads(), 0);
});

test('stale location writes conflict before field authorization against a newer technical state', async () => {
  const current = locationConfiguration();
  current.sites[0] = { ...current.sites[0], name: 'Berlin Campus' };
  const proposed = locationConfiguration();
  proposed.rooms[0] = { ...proposed.rooms[0], name: 'Executive Room' };
  const context = runtime({
    revision: 7,
    configuration: current,
    deniedPermissions: [PERMISSION.TENANT_CONFIGURE],
  });
  await assert.rejects(
    context.service.update({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 6,
      configuration: proposed,
    }),
    (error) => error instanceof TenantSettingsConflictError && error.currentRevision === 7,
  );
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 0);
  assert.equal(context.transitionAuthorizations(), 0);
  assert.deepEqual(context.permissionChecks, [PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE]);
  assert.deepEqual(context.authorizationDenials, []);
  assert.equal(context.currentReads(), 0);
});

test('current technical changes abort the mutation and record exactly one denial', async () => {
  const current = locationConfiguration();
  current.sites[0] = { ...current.sites[0], name: 'Berlin Campus' };
  const context = runtime({
    revision: 7,
    configuration: current,
    deniedPermissions: [PERMISSION.TENANT_CONFIGURE],
  });
  await assert.rejects(
    context.service.update({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 7,
      configuration: locationConfiguration(),
    }),
    AuthorizationDeniedError,
  );
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 0);
  assert.equal(context.transitionAuthorizations(), 1);
  assert.deepEqual(context.permissionChecks, [
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
    PERMISSION.TENANT_CONFIGURE,
  ]);
  assert.equal(context.authorizationDenials.length, 1);
  assert.equal(context.authorizationDenials[0].metadata.operation, 'update');
});

test('stale rollbacks conflict before loading or authorizing the historical transition', async () => {
  const context = runtime({
    revision: 7,
    deniedPermissions: [PERMISSION.TENANT_CONFIGURE],
  });
  await assert.rejects(
    context.service.rollback({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 6,
      sourceRevision: 1,
    }),
    (error) => error instanceof TenantSettingsConflictError && error.currentRevision === 7,
  );
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 0);
  assert.equal(context.revisionReads(), 0);
  assert.equal(context.transitionAuthorizations(), 0);
  assert.deepEqual(context.permissionChecks, [PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE]);
  assert.deepEqual(context.authorizationDenials, []);
});

test('current rollback requiring technical authority aborts and records one denial', async () => {
  const current = locationConfiguration();
  current.sites[0] = { ...current.sites[0], name: 'Berlin Campus' };
  const context = runtime({
    revision: 7,
    configuration: current,
    sourceConfiguration: locationConfiguration(),
    deniedPermissions: [PERMISSION.TENANT_CONFIGURE],
  });
  await assert.rejects(
    context.service.rollback({
      principal,
      tenantContext,
      correlationId: CORRELATION_ID,
      schemaVersion: 1,
      expectedRevision: 7,
      sourceRevision: 1,
    }),
    AuthorizationDeniedError,
  );
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 0);
  assert.equal(context.transitionAuthorizations(), 1);
  assert.equal(context.currentReads(), 0);
  assert.equal(context.revisionReads(), 0);
  assert.deepEqual(context.permissionChecks, [
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
    PERMISSION.TENANT_CONFIGURE,
  ]);
  assert.equal(context.authorizationDenials.length, 1);
  assert.equal(context.authorizationDenials[0].metadata.operation, 'rollback');
  assert.deepEqual(context.committedAuditEvents, []);
});

test('rollback classifies retained post-snapshot Rooms from the derived target', async () => {
  const source = locationConfiguration();
  const current = locationConfiguration({
    rooms: [
      ...source.rooms,
      { ...source.rooms[0], id: 'room-2', name: 'Room 2' },
    ],
  });
  const context = runtime({
    revision: 7,
    configuration: current,
    sourceConfiguration: source,
    deniedPermissions: [PERMISSION.TENANT_CONFIGURE],
  });
  const result = await context.service.rollback({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 7,
    sourceRevision: 1,
  });
  assert.equal(result.revision, 8);
  assert.deepEqual(result.configuration.rooms.map(({ id, active }) => ({ id, active })), [
    { id: 'room-1', active: true },
    { id: 'room-2', active: false },
  ]);
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 1);
  assert.equal(context.transitionAuthorizations(), 1);
  assert.equal(context.currentReads(), 0);
  assert.equal(context.revisionReads(), 0);
  assert.equal(context.calls[0].sourceRevision, 1);
  assert.deepEqual(context.permissionChecks, [
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
  ]);
  assert.deepEqual(context.authorizationDenials, []);
  assert.equal(context.committedAuditEvents.length, 1);
  assert.equal(
    context.committedAuditEvents[0].metadata.operation,
    'tenant_locations_rollback',
  );
  assert.equal(context.committedAuditEvents[0].metadata.sourceRevision, 1);
});

test('dual-role rollback authorizes the exact derived mixed transition', async () => {
  const source = locationConfiguration();
  const current = locationConfiguration();
  current.sites[0] = { ...current.sites[0], name: 'Berlin Campus' };
  current.rooms[0] = { ...current.rooms[0], name: 'Executive Room' };
  const context = runtime({
    revision: 7,
    configuration: current,
    sourceConfiguration: source,
  });
  const result = await context.service.rollback({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 7,
    sourceRevision: 1,
  });
  assert.equal(result.revision, 8);
  assert.deepEqual(result.configuration, source);
  assert.equal(context.calls.length, 1);
  assert.equal(context.commits(), 1);
  assert.equal(context.transitionAuthorizations(), 1);
  assert.equal(context.currentReads(), 0);
  assert.equal(context.revisionReads(), 0);
  assert.equal(context.calls[0].sourceRevision, 1);
  assert.deepEqual(context.permissionChecks, [
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
    PERMISSION.TENANT_CONFIGURE,
    PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE,
  ]);
  assert.deepEqual(context.authorizationDenials, []);
  assert.equal(context.committedAuditEvents.length, 1);
  assert.equal(
    context.committedAuditEvents[0].metadata.operation,
    'tenant_locations_rollback',
  );
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

test('Guest Room presentation rejects credential, URI and unsafe Unicode text at ingestion', () => {
  for (const disclosure of [
    'Door code 1234',
    'Doo\u0433 code 1234',
    'Door c\u0585de 1234',
    'D-o-o-\u0433 code 1234',
    'D.o.o.\u0433 c\u0585de 1234',
    'Doorcode1234',
    'Doorcode2',
    'Doorcode\u0662',
    'Door code1234',
    'PasswortSommer2026',
    'WiFipasswordSommer2026',
    'P\u0251ssword: Sommer2026',
    '\u1d18\u026a\u0274 1234',
    'passwordsecret',
    'doorcodeblue',
    'Doo \u0433 code 1234',
    '\u0440\u0430\u0455\u0455\u051d\u043e\u0433\u0501',
    'Door@code 1234',
    'Door$code 1234',
    'API@key abc123',
    'Door@c0de 1234',
    'Door$c0de 1234',
    'API@k3y abc123',
    'API$k3y abc123',
    'GuestPassword1234',
    'guestpassword1234',
    'MyPasswortSommer2026',
    'MainDoorcode1234',
    'OfficeDoor code 1234',
    'GuestWiFipasswordSommer2026',
    ['Secret', 'PIN1234'].join(''),
    '\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026',
    '\u13e2\u13c6\u13c1 1234',
    '\u13e2.\u13c6.\u13c1 1234',
    'Password sunshine',
    'https://internal.example.test/floor',
    'North\u202e2',
    '\tLevel 2',
    'Step-free\ud800access',
  ]) {
    for (const [field, value, code] of [
      ['floor', disclosure, 'TENANT_ROOM_FLOOR_INVALID'],
      ['accessibility', [disclosure], 'TENANT_ROOM_ACCESSIBILITY_INVALID'],
    ]) {
      const configuration = locationConfiguration();
      configuration.rooms[0] = { ...configuration.rooms[0], [field]: value };
      assert.throws(
        () => normalizeTenantLocations(configuration),
        (error) => error instanceof TenantLocationInputError && error.code === code,
      );
    }
  }
  const safe = locationConfiguration();
  safe.rooms[0] = {
    ...safe.rooms[0],
    floor: '1. OG',
    accessibility: ['Lift', 'Step-free entrance', 'Use Door 4 beside the north entrance.', 'Access ramp'],
  };
  const room = normalizeTenantLocations(safe).rooms[0];
  assert.equal(room.floor, '1. OG');
  assert.deepEqual(room.accessibility,
    ['Lift', 'Step-free entrance', 'Use Door 4 beside the north entrance.', 'Access ramp']);
  for (const floor of ['B[1]', 'Level -1', 'Étage 2']) {
    safe.rooms[0] = { ...safe.rooms[0], floor };
    assert.equal(normalizeTenantLocations(safe).rooms[0].floor, floor);
  }
  for (const floor of ['Door入口案内', 'Gate入口案内', 'Access入口案内',
    'Entrance入口案内', 'WiFi接続案内', 'WLAN接続案内', 'API利用案内', 'ᎣᏏᏲ ᎠᏰᎵ',
    'Meet at Door @ reception.', 'Parking costs $5 at reception.']) {
    safe.rooms[0] = { ...safe.rooms[0], floor };
    assert.equal(normalizeTenantLocations(safe).rooms[0].floor, floor);
  }
});


test('Locations v2 adds nullable exact Site guest configuration while v1 remains closed', async () => {
  const legacy = locationConfiguration();
  const configured = { ...legacy, sites: legacy.sites.map((site) => ({ ...site, guestInformation: null })) };
  const context = runtime({ configuration: configured });
  const result = await context.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4, configuration: configured });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.configuration.sites[0].guestInformation, null);
  assert.equal(context.calls[0].schemaVersion, 2);
  await assert.rejects(context.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 1, expectedRevision: 4, configuration: configured }),
  (error) => error.code === 'TENANT_LOCATIONS_INVALID');
  await assert.rejects(context.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4, configuration: legacy }),
  (error) => error.code === 'TENANT_LOCATIONS_INVALID');
  await assert.rejects(context.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4,
    configuration: { ...configured, sites: [{ ...configured.sites[0], guestInformation: { password: 'invalid' } }] },
  }), (error) => error.code === 'TENANT_SITE_GUEST_INFORMATION_INVALID');
});

test('Site guest information changes require Tenant Admin field authority and contain no values in audit', async () => {
  const legacy = locationConfiguration();
  const current = { ...legacy, sites: legacy.sites.map((site) => ({ ...site, guestInformation: null })) };
  const guest = { address: null, publicTransport: null, arrival: 'Ask at reception', parking: null,
    reception: null, building: null, visitorNotes: null, accessibility: null,
    wifiPolicy: 'not_available', wifiNetworkName: null, contact: null, routeUrl: null };
  const proposed = { ...current, sites: [{ ...current.sites[0], guestInformation: guest }] };
  const manager = runtime({ configuration: current, deniedPermissions: [PERMISSION.TENANT_CONFIGURE] });
  await assert.rejects(manager.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4, configuration: proposed }), AuthorizationDeniedError);
  assert.equal(manager.commits(), 0);
  assert.equal(manager.authorizationDenials.length, 1);
  const admin = runtime({ configuration: current, deniedPermissions: [PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE] });
  const saved = await admin.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4, configuration: proposed });
  assert.equal(saved.configuration.sites[0].guestInformation.arrival, guest.arrival);
  assert.equal(admin.commits(), 1);
  assert.equal(JSON.stringify(admin.committedAuditEvents).includes(guest.arrival), false);
  const stale = runtime({ configuration: current, lockedRevision: 5 });
  await assert.rejects(stale.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 2, expectedRevision: 4, configuration: proposed }), TenantSettingsConflictError);
  assert.equal(stale.commits(), 0);
});

test('Locations v3 enforces Site and Room structured value ownership independently', async () => {
  const legacy = locationConfiguration();
  const current = {
    sites: legacy.sites.map((site) => ({ ...site, guestInformation: null, guestPublicValues: null })),
    rooms: legacy.rooms.map((room) => ({ ...room, guestPublicValues: null })),
  };
  const siteValue = { publicTransport: 'available', parking: 'not_available',
    arrival: 'reception', accessibilityFeatures: ['step_free_entry'] };
  const roomValue = { floorNumber: 2, accessibilityFeatures: ['lift'] };
  const siteOnly = { ...current,
    sites: [{ ...current.sites[0], guestPublicValues: siteValue }] };
  const roomOnly = { ...current,
    rooms: [{ ...current.rooms[0], guestPublicValues: roomValue }] };
  const manager = runtime({ configuration: current, deniedPermissions: [PERMISSION.TENANT_CONFIGURE] });
  await assert.rejects(manager.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 3, expectedRevision: 4, configuration: siteOnly }), AuthorizationDeniedError);
  assert.equal(manager.commits(), 0);
  const roomResult = await manager.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 3, expectedRevision: 4, configuration: roomOnly });
  assert.deepEqual(roomResult.configuration.rooms[0].guestPublicValues, roomValue);
  const admin = runtime({ configuration: current,
    deniedPermissions: [PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE] });
  await assert.rejects(admin.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 3, expectedRevision: 4, configuration: roomOnly }), AuthorizationDeniedError);
  assert.equal(admin.commits(), 0);
  const siteResult = await admin.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 3, expectedRevision: 4, configuration: siteOnly });
  assert.deepEqual(siteResult.configuration.sites[0].guestPublicValues, siteValue);
  const invalid = { ...current,
    sites: [{ ...current.sites[0], guestPublicValues: { ...siteValue, arrival: 'door code 1234' } }] };
  await assert.rejects(admin.service.update({ principal, tenantContext, correlationId: CORRELATION_ID,
    schemaVersion: 3, expectedRevision: 4, configuration: invalid }),
  (error) => error.code === 'PUBLIC_GUEST_VALUES_INVALID');
  assert.equal(admin.commits(), 1);
  assert.equal(JSON.stringify(admin.committedAuditEvents).includes('step_free_entry'), false);
});
