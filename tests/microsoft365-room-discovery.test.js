import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Microsoft365ProviderError,
  createMicrosoft365Client,
} from '../src/integrations/microsoft365-client.js';
import { createMicrosoft365RoomDiscoveryService } from '../src/application/microsoft365-room-discovery-service.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 't'.repeat(64);

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl) {
  return createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'test-secret-not-a-real-secret',
    publicOrigin: 'http://localhost:3000',
    allowInsecureLocalhost: true,
    fetchImpl,
    applicationFactory: () => ({
      acquireTokenByClientCredential: async () => ({ accessToken: TOKEN }),
    }),
  });
}

function graphRoom(index, overrides = {}) {
  return {
    id: `room-${index}`,
    displayName: `Room ${index}`,
    emailAddress: `room-${index}@example.invalid`,
    capacity: 8,
    building: 'HQ',
    floorNumber: 2,
    ...overrides,
  };
}

test('room discovery normalizes provider data and never exposes the access token', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => {
    requests.push({ url: url.toString(), authorization: options.headers.Authorization });
    return jsonResponse(200, { value: [graphRoom(1, { nickname: null, phone: 42 })] });
  });

  const rooms = await client.discoverRooms({ tenantReference: TENANT_A });
  assert.deepEqual(rooms, [{
    externalRoomId: 'room-1',
    displayName: 'Room 1',
    resourceAddress: 'room-1@example.invalid',
    capacity: 8,
    building: 'HQ',
    floorNumber: 2,
    floorLabel: null,
    label: null,
    nickname: null,
    phone: null,
    audioDeviceName: null,
    videoDeviceName: null,
    displayDeviceName: null,
    bookingType: null,
  }]);
  assert.equal(requests.length, 1);
  const graphUrl = new URL(requests[0].url);
  assert.equal(graphUrl.origin, 'https://graph.microsoft.com');
  assert.equal(graphUrl.pathname, '/v1.0/places/microsoft.graph.room');
  assert.equal(graphUrl.searchParams.get('$top'), '100');
  assert.equal(graphUrl.searchParams.get('$skip'), '0');
  assert.equal(JSON.stringify(rooms).includes(TOKEN), false);
});

test('room discovery paginates with fixed Graph URLs', async () => {
  const skips = [];
  const client = clientWith(async (url) => {
    const skip = Number(url.searchParams.get('$skip'));
    skips.push(skip);
    if (skip === 0) return jsonResponse(200, { value: Array.from({ length: 100 }, (_, index) => graphRoom(index)) });
    return jsonResponse(200, { value: [graphRoom(100)] });
  });

  const rooms = await client.discoverRooms({ tenantReference: TENANT_A });
  assert.equal(rooms.length, 101);
  assert.deepEqual(skips, [0, 100]);
});

test('room discovery rejects malformed required provider identity fields', async () => {
  const client = clientWith(async () => jsonResponse(200, {
    value: [{ id: 'room-1', displayName: 'Room 1', emailAddress: null }],
  }));
  await assert.rejects(
    () => client.discoverRooms({ tenantReference: TENANT_A }),
    (error) => error instanceof Microsoft365ProviderError && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
  );
});

test('room discovery classifies permission and throttling failures without provider bodies', async () => {
  for (const [status, code] of [[403, 'MICROSOFT365_GRAPH_PERMISSION_MISSING'], [429, 'MICROSOFT365_GRAPH_THROTTLED']]) {
    const client = clientWith(async () => jsonResponse(status, { error: { message: 'sensitive provider detail' } }));
    await assert.rejects(
      () => client.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError && error.code === code && !error.message.includes('sensitive'),
    );
  }
});

test('room discovery service derives provider tenant only from the trusted tenant binding', async () => {
  const providerCalls = [];
  const service = createMicrosoft365RoomDiscoveryService({
    connectionRepository: {
      findByTenantId: async (tenantId) => ({
        tenantId,
        status: 'connected',
        placesPermission: 'granted',
        providerTenantReference: TENANT_A,
      }),
    },
    bindingRepository: {
      findActiveBindingByTenantId: async () => ({ providerTenantReference: TENANT_A }),
    },
    authorizationPolicy: { requireTenantPermission: () => {} },
    auditService: { recordAuthorizationDenied: async () => {} },
    providerClient: {
      discoverRooms: async ({ tenantReference }) => {
        providerCalls.push(tenantReference);
        return Object.freeze([graphRoom(1)]);
      },
    },
  });

  const rooms = await service.discoverRooms({
    principal: { userId: '33333333-3333-4333-8333-333333333333' },
    tenantContext: { tenantId: '44444444-4444-4444-8444-444444444444' },
    correlationId: CORRELATION_ID,
  });
  assert.equal(rooms.length, 1);
  assert.deepEqual(providerCalls, [TENANT_A]);
});

test('room discovery service fails closed when connection and active binding point to different Entra tenants', async () => {
  let providerCalled = false;
  const service = createMicrosoft365RoomDiscoveryService({
    connectionRepository: {
      findByTenantId: async () => ({
        status: 'connected',
        placesPermission: 'granted',
        providerTenantReference: TENANT_A,
      }),
    },
    bindingRepository: {
      findActiveBindingByTenantId: async () => ({ providerTenantReference: TENANT_B }),
    },
    authorizationPolicy: { requireTenantPermission: () => {} },
    auditService: { recordAuthorizationDenied: async () => {} },
    providerClient: {
      discoverRooms: async () => { providerCalled = true; return []; },
    },
  });

  await assert.rejects(
    () => service.discoverRooms({
      principal: { userId: '33333333-3333-4333-8333-333333333333' },
      tenantContext: { tenantId: '44444444-4444-4444-8444-444444444444' },
      correlationId: CORRELATION_ID,
    }),
    (error) => error.code === 'MICROSOFT365_PROVIDER_TENANT_MISMATCH',
  );
  assert.equal(providerCalled, false);
});
