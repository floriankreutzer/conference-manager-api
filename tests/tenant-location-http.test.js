import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createTenantLocationAdministrationService } from '../src/application/tenant-location-administration-service.js';
import { createAuthorizationPolicy, PERMISSION, TENANT_ROLE } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import {
  tenantLocationRollbackConfiguration,
  tenantLocationsV1Projection,
} from '../src/domain/tenant-locations.js';
import { createLogger } from '../src/logger.js';
import { createHttpServer } from '../src/server.js';
import { TENANT_STATUS } from '../src/tenancy/tenant.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = '33333333-3333-4333-8333-333333333333';
const ADMIN_B = '44444444-4444-4444-8444-444444444444';
const EMPLOYEE_A = '55555555-5555-4555-8555-555555555555';
const SESSION_A = '66666666-6666-4666-8666-666666666666';
const CSRF_TOKEN = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const LOCATIONS_PATH = '/api/v1/tenant/settings/locations';

function configuration(siteId, roomId) {
  return {
    sites: [{
      id: siteId,
      name: `Site ${siteId}`,
      active: true,
      timeZone: 'Europe/Berlin',
      address: null,
    }],
    rooms: [{
      id: roomId,
      siteId,
      name: `Room ${roomId}`,
      capacity: 12,
      active: true,
      floor: null,
      equipment: [],
      accessibility: [],
      serviceIds: [],
      cateringPackageIds: [],
      floorplanAssetId: null,
      mediaAssetIds: [],
    }],
  };
}

function guestInformation(changes = {}) {
  return {
    address: null,
    publicTransport: null,
    arrival: null,
    parking: null,
    reception: null,
    building: null,
    visitorNotes: null,
    accessibility: null,
    wifiPolicy: 'not_available',
    wifiNetworkName: null,
    contact: null,
    routeUrl: null,
    ...changes,
  };
}

function guestProjection(value, guestBySite) {
  return {
    sites: value.sites.map((site) => ({
      ...site,
      guestInformation: guestBySite.get(site.id) ?? null,
    })),
    rooms: value.rooms,
  };
}

function guestSnapshot(value) {
  return new Map(value.sites.map((site) => [site.id, site.guestInformation]));
}

function principal({ tenantId = TENANT_A, userId = ADMIN_A, admin = true } = {}) {
  return {
    userId,
    tenantId,
    providerIdentity: { provider: 'test_oidc', reference: `${tenantId}:${userId}` },
    roles: [admin ? TENANT_ROLE.TENANT_ADMIN : TENANT_ROLE.EMPLOYEE],
    permissions: admin
      ? [PERMISSION.TENANT_CONFIGURE]
      : [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL],
    session: {
      id: SESSION_A,
      issuedAt: '2026-08-27T08:00:00.000Z',
      expiresAt: '2026-08-27T18:00:00.000Z',
      securityVersion: 1,
    },
  };
}

function tenant(tenantId) {
  return {
    id: tenantId,
    displayName: `Tenant ${tenantId}`,
    status: TENANT_STATUS.ACTIVE,
    createdAt: '2026-08-27T08:00:00.000Z',
    updatedAt: '2026-08-27T08:00:00.000Z',
  };
}

function createMemoryRepository() {
  const initialAt = '2026-08-27T08:00:00.000Z';
  const state = (tenantId, siteId, roomId, actorUserId) => {
    const initial = configuration(siteId, roomId);
    const initialGuests = new Map([[siteId, null]]);
    return {
      revision: 1,
      configuration: initial,
      guestBySite: initialGuests,
      history: new Map([[1, {
        revision: 1,
        configuration: initial,
        guestBySite: initialGuests,
        changedAt: initialAt,
        actorUserId,
      }]]),
      tenantId,
    };
  };
  const states = new Map([
    [TENANT_A, state(TENANT_A, 'site-a', 'room-a', ADMIN_A)],
    [TENANT_B, state(TENANT_B, 'site-b', 'room-b', ADMIN_B)],
  ]);
  const calls = [];
  const resultFor = (state, schemaVersion = 1) => ({
    revision: state.revision,
    configuration: schemaVersion === 2
      ? guestProjection(state.configuration, state.guestBySite)
      : state.configuration,
    providerContext: [],
  });
  return {
    calls,
    async current(tenantId, { schemaVersion = 1 } = {}) {
      calls.push({ operation: 'current', tenantId, schemaVersion });
      return resultFor(states.get(tenantId), schemaVersion);
    },
    async update(args) {
      calls.push({ operation: 'update', tenantId: args.tenantId, schemaVersion: args.schemaVersion });
      const state = states.get(args.tenantId);
      if (args.expectedRevision !== state.revision) {
        return { status: 'conflict', currentRevision: state.revision };
      }
      const current = args.schemaVersion === 2
        ? guestProjection(state.configuration, state.guestBySite)
        : state.configuration;
      args.assertAuthorizedTransition(current, args.configuration);
      state.revision = args.nextRevision;
      if (args.schemaVersion === 2) {
        state.guestBySite = guestSnapshot(args.configuration);
        state.configuration = tenantLocationsV1Projection(args.configuration);
      } else {
        state.configuration = args.configuration;
        state.guestBySite = new Map(state.configuration.sites.map((site) => [
          site.id,
          state.guestBySite.get(site.id) ?? null,
        ]));
      }
      state.history.set(state.revision, {
        revision: state.revision,
        configuration: state.configuration,
        guestBySite: new Map(state.guestBySite),
        changedAt: args.changedAt.toISOString(),
        actorUserId: args.actorUserId,
      });
      return resultFor(state, args.schemaVersion);
    },
    async history(tenantId, limit) {
      calls.push({ operation: 'history', tenantId, limit });
      return [...states.get(tenantId).history.values()]
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit)
        .map(({ revision, changedAt, actorUserId }) => ({ revision, changedAt, actorUserId }));
    },
    async revision(tenantId, revision, { schemaVersion = 1 } = {}) {
      calls.push({ operation: 'revision', tenantId, revision, schemaVersion });
      const snapshot = states.get(tenantId).history.get(revision);
      return snapshot ? {
        ...snapshot,
        configuration: schemaVersion === 2
          ? guestProjection(snapshot.configuration, snapshot.guestBySite)
          : snapshot.configuration,
      } : null;
    },
    async rollback(args) {
      calls.push({ operation: 'rollback', tenantId: args.tenantId, schemaVersion: args.schemaVersion });
      const state = states.get(args.tenantId);
      if (args.expectedRevision !== state.revision) {
        return { status: 'conflict', currentRevision: state.revision };
      }
      const source = state.history.get(args.sourceRevision);
      if (!source) {
        const error = new Error('TENANT_LOCATION_REVISION_NOT_FOUND');
        error.code = 'TENANT_LOCATION_REVISION_NOT_FOUND';
        throw error;
      }
      const proposed = tenantLocationRollbackConfiguration(
        state.configuration,
        source.configuration,
      );
      const current = args.schemaVersion === 2
        ? guestProjection(state.configuration, state.guestBySite)
        : state.configuration;
      const authorizedProposed = args.schemaVersion === 2
        ? guestProjection(proposed, source.guestBySite)
        : proposed;
      args.assertAuthorizedTransition(current, authorizedProposed);
      state.revision = args.nextRevision;
      state.configuration = proposed;
      if (args.schemaVersion === 2) state.guestBySite = guestSnapshot(authorizedProposed);
      state.history.set(state.revision, {
        revision: state.revision,
        configuration: state.configuration,
        guestBySite: new Map(state.guestBySite),
        changedAt: args.changedAt.toISOString(),
        actorUserId: args.actorUserId,
      });
      return resultFor(state, args.schemaVersion);
    },
  };
}

function request({ port, path = LOCATIONS_PATH, method = 'GET', actor = 'admin-a', body, csrf }) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : JSON.stringify(body);
    const headers = { Host: `localhost:${port}` };
    if (actor !== null) headers['X-Test-Principal'] = actor;
    if (csrf !== undefined) headers['X-CSRF-Token'] = csrf;
    if (encoded !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(encoded);
    }
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    outgoing.on('error', reject);
    if (encoded !== null) outgoing.write(encoded);
    outgoing.end();
  });
}

async function withServer(run) {
  const repository = createMemoryRepository();
  const denials = [];
  const logs = [];
  const service = createTenantLocationAdministrationService({
    repository,
    authorizationPolicy: createAuthorizationPolicy(),
    auditService: {
      createEvent: (event) => event,
      async recordAuthorizationDenied(event) { denials.push(event); },
    },
    clock: () => Date.parse('2026-08-27T09:00:00.000Z'),
  });
  const principals = new Map([
    ['admin-a', principal()],
    ['admin-b', principal({ tenantId: TENANT_B, userId: ADMIN_B })],
    ['employee-a', principal({ userId: EMPLOYEE_A, admin: false })],
  ]);
  const config = { ...loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_MAX: '200',
  }) };
  let legacyWrites = 0;
  const server = createHttpServer({
    config,
    logger: createLogger({ write(line) { logs.push(line); } }),
    tenantLocationAdministrationService: service,
    productionApplicationService: {
      async getConfiguration() { return {}; },
      async updateConfiguration() { legacyWrites += 1; return {}; },
    },
    resolvePrincipal: async (incoming) => principals.get(incoming.headers['x-test-principal']) ?? null,
    verifyCsrf: async (incoming) => incoming.headers['x-csrf-token'] === CSRF_TOKEN,
    loadTenant: async (tenantId) => [TENANT_A, TENANT_B].includes(tenantId) ? tenant(tenantId) : null,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  config.publicOrigin = `http://localhost:${port}`;
  try {
    await run({ port, repository, denials, logs, legacyWrites: () => legacyWrites });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Locations HTTP requires authentication and audits Tenant Admin authorization denial', async () => {
  await withServer(async ({ port, repository, denials }) => {
    const unauthenticated = await request({ port, actor: null });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.body.error.code, 'UNAUTHENTICATED');

    const employee = await request({ port, actor: 'employee-a' });
    assert.equal(employee.statusCode, 403);
    assert.equal(employee.body.error.code, 'FORBIDDEN');
    assert.equal(repository.calls.length, 0);
    assert.equal(denials.length, 1);
    assert.equal(denials[0].principal.userId, EMPLOYEE_A);
    assert.deepEqual(denials[0].metadata, { operation: 'read' });
  });
});

test('Locations HTTP derives and preserves independent Tenant scope from the Principal', async () => {
  await withServer(async ({ port, repository }) => {
    const first = await request({ port, actor: 'admin-a' });
    const second = await request({ port, actor: 'admin-b' });
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.locations.configuration.sites[0].id, 'site-a');
    assert.equal(second.body.locations.configuration.sites[0].id, 'site-b');
    assert.deepEqual(repository.calls.map(({ tenantId }) => tenantId), [TENANT_A, TENANT_B]);

    const selector = await request({ port, path: `${LOCATIONS_PATH}?tenantId=${TENANT_B}` });
    assert.equal(selector.statusCode, 400);
    assert.equal(selector.body.error.code, 'VALIDATION_FAILED');
  });
});

test('Locations v2 is explicitly negotiated while every v1 HTTP projection remains exact', async () => {
  await withServer(async ({ port, repository }) => {
    const legacy = await request({ port });
    assert.equal(legacy.statusCode, 200);
    assert.equal(legacy.body.locations.schemaVersion, 1);
    assert.equal(Object.hasOwn(legacy.body.locations.configuration.sites[0], 'guestInformation'), false);

    const versioned = await request({ port, path: `${LOCATIONS_PATH}?schemaVersion=2` });
    assert.equal(versioned.statusCode, 200);
    assert.equal(versioned.body.locations.schemaVersion, 2);
    assert.equal(versioned.body.locations.configuration.sites[0].guestInformation, null);
    const historical = await request({ port, path: `${LOCATIONS_PATH}/history/1?schemaVersion=2` });
    assert.equal(historical.statusCode, 200);
    assert.equal(historical.body.revision.configuration.sites[0].guestInformation, null);

    for (const query of [
      'schemaVersion=1',
      'schemaVersion=3',
      'schemaVersion=2&schemaVersion=2',
      `schemaVersion=2&tenantId=${TENANT_B}`,
    ]) {
      const result = await request({ port, path: `${LOCATIONS_PATH}?${query}` });
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, 'VALIDATION_FAILED');
    }

    const configured = {
      ...configuration('site-a', 'room-a'),
      sites: [{
        ...configuration('site-a', 'room-a').sites[0],
        guestInformation: guestInformation({ arrival: 'Register at reception.' }),
      }],
    };
    const updated = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 2, expectedRevision: 1, configuration: configured },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.locations.schemaVersion, 2);
    assert.equal(updated.body.locations.configuration.sites[0].guestInformation.arrival,
      'Register at reception.');

    const preservedLegacy = await request({ port });
    assert.equal(Object.hasOwn(preservedLegacy.body.locations.configuration.sites[0], 'guestInformation'), false);
    const restored = await request({
      port,
      path: `${LOCATIONS_PATH}/rollback`,
      method: 'POST',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 2, expectedRevision: 2, sourceRevision: 1 },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.body.locations.schemaVersion, 2);
    assert.equal(restored.body.locations.configuration.sites[0].guestInformation, null);
    assert.deepEqual(repository.calls.filter(({ operation }) => operation === 'current')
      .map(({ schemaVersion }) => schemaVersion), [1, 2, 1]);
  });
});

test('Locations v2 rejects credential disclosures before persistence and never logs their values', async () => {
  await withServer(async ({ port, repository, logs }) => {
    const disclosures = [
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
      'PASSWORDSecret',
      '1Password: Secret',
      'Door@code 1234',
      'API@key abc123',
      'Door@c0de 1234',
      'Door$c0de 1234',
      'API@k3y abc123',
      'API$k3y abc123',
      'GuestPassword1234',
      'MainDoorcode1234',
      'OfficeDoor code 1234',
      ['Secret', 'PIN1234'].join(''),
      '\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026',
      '\u13e2\u13c6\u13c1 1234',
      '\u13e2.\u13c6.\u13c1 1234',
      'Passwort lautet Sommer2026',
      'Wi-Fi password Sommer2026',
      'Wi-Fi code 1234',
      'WLAN code 1234',
      'Guest WiFi code alpha',
      'API key abc123',
      'Voucher: ABCD-1234',
      'Pass\u051dord Sommer2026',
      'Passcode 1234',
      'Wi-Fi passcode 1234',
      'Auth token abc',
      'One-time code 1234',
      'WiFi secret abc',
      'Access key abc',
      'P-a-s-s-w-o-r-d S0mmer2026',
      'Pаsswоrd Sommer2026',
    ];
    for (const disclosure of disclosures) {
      const proposed = configuration('site-a', 'room-a');
      proposed.sites[0].guestInformation = guestInformation({ arrival: disclosure });
      const result = await request({
        port,
        method: 'PUT',
        csrf: CSRF_TOKEN,
        body: { schemaVersion: 2, expectedRevision: 1, configuration: proposed },
      });
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, 'VALIDATION_FAILED');
      assert.equal(logs.some((line) => line.includes(disclosure)), false);
    }
    for (const [field, disclosure] of [
      ['floor', 'Door code 1234'],
      ['floor', 'Doo\u0433 code 1234'],
      ['accessibility', ['Door c\u0585de 1234']],
      ['floor', 'D-o-o-\u0433 code 1234'],
      ['accessibility', ['D.o.o.\u0433 c\u0585de 1234']],
      ['floor', 'Doorcode1234'],
      ['accessibility', ['PasswortSommer2026']],
      ['floor', 'GuestPassword1234'],
      ['accessibility', ['MainDoorcode1234']],
      ['floor', ['Secret', 'PIN1234'].join('')],
      ['accessibility', ['\u13e2\u13aa\u13da\u13da\u13b3\u13be\u13a1\u13a0 Sommer2026']],
      ['floor', 'Door@c0de 1234'],
      ['accessibility', ['API$k3y abc123']],
      ['floor', '\u13e2\u13c6\u13c1 1234'],
      ['floor', 'https://internal.example.test/floor'],
      ['floor', 'North\u202e2'],
      ['accessibility', ['Password sunshine']],
      ['accessibility', ['Wi-Fi code 1234']],
    ]) {
      const proposed = configuration('site-a', 'room-a');
      proposed.rooms[0] = { ...proposed.rooms[0], [field]: disclosure };
      const result = await request({
        port,
        method: 'PUT',
        csrf: CSRF_TOKEN,
        body: { schemaVersion: 2, expectedRevision: 1, configuration: proposed },
      });
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, 'VALIDATION_FAILED');
      const sensitiveValue = Array.isArray(disclosure) ? disclosure[0] : disclosure;
      assert.equal(logs.some((line) => line.includes(sensitiveValue)), false);
    }
    assert.equal(repository.calls.length, 0);

    const valid = configuration('site-a', 'room-a');
    valid.sites[0].guestInformation = guestInformation({
      arrival: 'Enter through Door 4 beside the north entrance.',
      wifiPolicy: 'open',
      wifiNetworkName: 'Conference Guest Wi-Fi',
    });
    const accepted = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 2, expectedRevision: 1, configuration: valid },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body.locations.configuration.sites[0].guestInformation.wifiNetworkName,
      'Conference Guest Wi-Fi');
  });
});

test('Locations PUT requires CSRF and rejects authority or provider-shaped input', async () => {
  await withServer(async ({ port, repository }) => {
    const validBody = {
      schemaVersion: 1,
      expectedRevision: 1,
      configuration: configuration('site-a', 'room-a'),
    };
    const noCsrf = await request({ port, method: 'PUT', body: validBody });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.body.error.code, 'CSRF_INVALID');

    const authority = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { ...validBody, tenantId: TENANT_B },
    });
    assert.equal(authority.statusCode, 400);
    assert.equal(authority.body.error.code, 'VALIDATION_FAILED');

    const provider = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: {
        ...validBody,
        configuration: {
          ...validBody.configuration,
          rooms: [{ ...validBody.configuration.rooms[0], externalRoomId: 'provider-room' }],
        },
      },
    });
    assert.equal(provider.statusCode, 400);
    assert.equal(provider.body.error.code, 'VALIDATION_FAILED');
    assert.equal(repository.calls.length, 0);

    const updated = await request({ port, method: 'PUT', csrf: CSRF_TOKEN, body: validBody });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.locations.revision, 2);
    assert.equal(repository.calls[0].tenantId, TENANT_A);
  });
});

test('stale Locations writes expose exactly the bounded revision-conflict envelope', async () => {
  await withServer(async ({ port }) => {
    const stale = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: {
        schemaVersion: 1,
        expectedRevision: 9,
        configuration: configuration('site-a', 'room-a'),
      },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.error.code, 'TENANT_SETTINGS_REVISION_CONFLICT');
    assert.equal(stale.body.error.currentRevision, 1);
    assert.match(stale.body.error.requestId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(Object.keys(stale.body.error).sort(), ['code', 'currentRevision', 'requestId']);
  });
});

test('Locations history and rollback progress through immutable Tenant-scoped revisions', async () => {
  await withServer(async ({ port }) => {
    const changed = configuration('site-a', 'room-a');
    changed.sites[0].name = 'Changed Site A';
    const updated = await request({
      port,
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 1, expectedRevision: 1, configuration: changed },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.locations.revision, 2);

    const history = await request({ port, path: `${LOCATIONS_PATH}/history?limit=2` });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(history.body.history.map(({ revision }) => revision), [2, 1]);
    assert.deepEqual(Object.keys(history.body.history[0]).sort(), ['actorUserId', 'changedAt', 'revision']);

    const source = await request({ port, path: `${LOCATIONS_PATH}/history/1` });
    assert.equal(source.statusCode, 200);
    assert.equal(source.body.revision.configuration.sites[0].name, 'Site site-a');

    const rolledBack = await request({
      port,
      path: `${LOCATIONS_PATH}/rollback`,
      method: 'POST',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 1, expectedRevision: 2, sourceRevision: 1 },
    });
    assert.equal(rolledBack.statusCode, 200);
    assert.equal(rolledBack.body.locations.revision, 3);
    assert.equal(rolledBack.body.locations.configuration.sites[0].name, 'Site site-a');
  });
});

test('Locations history and rollback reject malformed input and preserve Tenant boundaries', async () => {
  await withServer(async ({ port }) => {
    for (const path of [LOCATIONS_PATH, `${LOCATIONS_PATH}/history`, `${LOCATIONS_PATH}/history/1`]) {
      const withBody = await request({ port, path, body: {} });
      assert.equal(withBody.statusCode, 400);
      assert.equal(withBody.body.error.code, 'REQUEST_BODY_NOT_ALLOWED');
    }
    for (const path of [
      `${LOCATIONS_PATH}/history?limit=0`,
      `${LOCATIONS_PATH}/history?limit=101`,
      `${LOCATIONS_PATH}/history?limit=1&limit=2`,
      `${LOCATIONS_PATH}/history?tenantId=${TENANT_B}`,
    ]) {
      const result = await request({ port, path });
      assert.equal(result.statusCode, 400);
      assert.equal(result.body.error.code, 'VALIDATION_FAILED');
    }
    const missing = await request({ port, path: `${LOCATIONS_PATH}/history/999` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');

    const noCsrf = await request({
      port,
      path: `${LOCATIONS_PATH}/rollback`,
      method: 'POST',
      body: { schemaVersion: 1, expectedRevision: 1, sourceRevision: 1 },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.body.error.code, 'CSRF_INVALID');
    const authority = await request({
      port,
      path: `${LOCATIONS_PATH}/rollback`,
      method: 'POST',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 1, expectedRevision: 1, sourceRevision: 1, tenantId: TENANT_B },
    });
    assert.equal(authority.statusCode, 400);
    assert.equal(authority.body.error.code, 'VALIDATION_FAILED');

    const tenantBUpdate = await request({
      port,
      actor: 'admin-b',
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 1, expectedRevision: 1, configuration: configuration('site-b', 'room-b') },
    });
    assert.equal(tenantBUpdate.statusCode, 200);
    const foreignRevision = await request({ port, path: `${LOCATIONS_PATH}/history/2` });
    assert.equal(foreignRevision.statusCode, 404);
    const foreignRollback = await request({
      port,
      path: `${LOCATIONS_PATH}/rollback`,
      method: 'POST',
      csrf: CSRF_TOKEN,
      body: { schemaVersion: 1, expectedRevision: 1, sourceRevision: 2 },
    });
    assert.equal(foreignRollback.statusCode, 400);
    assert.equal(foreignRollback.body.error.code, 'VALIDATION_FAILED');
    assert.equal((await request({ port })).body.locations.revision, 1);
  });
});

test('legacy application configuration PUT cannot bypass Locations revision control', async () => {
  await withServer(async ({ port, legacyWrites }) => {
    const result = await request({
      port,
      path: '/api/v1/application/configuration',
      method: 'PUT',
      csrf: CSRF_TOKEN,
      body: { sites: [] },
    });
    assert.equal(result.statusCode, 405);
    assert.equal(result.body.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(legacyWrites(), 0);
  });
});
