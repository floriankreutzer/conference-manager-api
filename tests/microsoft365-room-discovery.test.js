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

function roomNextLink(currentUrl, continuation, kind = '$skip') {
  const next = new URL(currentUrl);
  next.searchParams.delete('$skip');
  next.searchParams.delete('$skiptoken');
  next.searchParams.set(kind, String(continuation));
  return next.toString();
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

test('room discovery shares one deadline across identity token acquisition and every Graph page', async () => {
  const signals = [];
  const client = createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'test-secret-not-a-real-secret',
    publicOrigin: 'http://localhost:3000',
    allowInsecureLocalhost: true,
    fetchImpl: async (url, options) => {
      signals.push(options.signal);
      if (new URL(url).origin === 'https://login.microsoftonline.com') {
        return jsonResponse(200, { ok: true });
      }
      return jsonResponse(200, { value: [graphRoom(1)] });
    },
    applicationFactory: ({ networkClient }) => ({
      async acquireTokenByClientCredential() {
        await networkClient.sendGetRequestAsync(
          `https://login.microsoftonline.com/${TENANT_A}/v2.0/.well-known/openid-configuration`,
        );
        return { accessToken: TOKEN };
      },
    }),
  });

  await client.discoverRooms({ tenantReference: TENANT_A });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
});

test('room discovery paginates with fixed Graph URLs', async () => {
  const skips = [];
  const signals = [];
  const client = clientWith(async (url, options) => {
    const skip = Number(url.searchParams.get('$skip'));
    skips.push(skip);
    signals.push(options.signal);
    if (skip === 0) return jsonResponse(200, {
      value: Array.from({ length: 100 }, (_, index) => graphRoom(index)),
      '@odata.nextLink': roomNextLink(url, 100),
    });
    return jsonResponse(200, { value: [graphRoom(100)] });
  });

  const rooms = await client.discoverRooms({ tenantReference: TENANT_A });
  assert.equal(rooms.length, 101);
  assert.deepEqual(skips, [0, 100]);
  assert.equal(signals[0], signals[1]);
});

test('room discovery enforces a bounded aggregate collection before another page is requested', async () => {
  let calls = 0;
  const client = clientWith(async (url) => {
    calls += 1;
    const skip = Number(url.searchParams.get('$skip'));
    return jsonResponse(200, {
      value: Array.from({ length: 100 }, (_, index) => graphRoom(skip + index)),
      '@odata.nextLink': roomNextLink(url, skip + 100),
    });
  });

  await assert.rejects(
    () => client.discoverRooms({ tenantReference: TENANT_A }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_ROOM_COLLECTION_LIMIT_EXCEEDED',
  );
  assert.equal(calls, 10);
});

test('room discovery follows short and empty pages until nextLink is absent', async () => {
  const requested = [];
  const client = clientWith(async (url) => {
    requested.push(url.toString());
    const cursor = url.searchParams.get('$skiptoken');
    if (cursor === null) return jsonResponse(200, {
      value: [graphRoom(1)],
      '@odata.nextLink': roomNextLink(url, 'empty', '$skiptoken'),
    });
    if (cursor === 'empty') return jsonResponse(200, {
      value: [],
      '@odata.nextLink': roomNextLink(url, 'last', '$skiptoken'),
    });
    return jsonResponse(200, { value: [graphRoom(2)] });
  });

  const rooms = await client.discoverRooms({ tenantReference: TENANT_A });
  assert.deepEqual(rooms.map((room) => room.externalRoomId), ['room-1', 'room-2']);
  assert.equal(requested.length, 3);
});

test('room discovery rejects untrusted, looping and overlong nextLink values before transport', async () => {
  const invalidLinks = [
    'https://example.invalid/v1.0/places/microsoft.graph.room?$skiptoken=1',
    'https://graph.microsoft.com/v1.0/users?$skiptoken=1',
    'https://user:password@graph.microsoft.com/v1.0/places/microsoft.graph.room?$skiptoken=1',
    'https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$skiptoken=1#fragment',
    `https://graph.microsoft.com/v1.0/places/microsoft.graph.room?$skiptoken=${'x'.repeat(4_096)}`,
  ];
  for (const nextLink of invalidLinks) {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return jsonResponse(200, { value: [], '@odata.nextLink': nextLink });
    });
    await assert.rejects(
      client.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
    );
    assert.equal(calls, 1);
  }

  let loopCalls = 0;
  let repeated;
  const looping = clientWith(async (url) => {
    loopCalls += 1;
    repeated ||= roomNextLink(url, 1);
    return jsonResponse(200, { value: [], '@odata.nextLink': repeated });
  });
  await assert.rejects(
    looping.discoverRooms({ tenantReference: TENANT_A }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
  );
  assert.equal(loopCalls, 2);
});

test('room discovery permits only the original bounded query plus one opaque continuation', async () => {
  const invalidLinks = [
    (url) => {
      const next = new URL(roomNextLink(url, 1));
      next.searchParams.set('$filter', 'capacity gt 0');
      return next.toString();
    },
    (url) => {
      const next = new URL(roomNextLink(url, 1));
      next.searchParams.set('$top', '99');
      return next.toString();
    },
    (url) => {
      const next = new URL(roomNextLink(url, 1));
      next.searchParams.set('$select', 'id,emailAddress');
      return next.toString();
    },
    (url) => {
      const next = new URL(roomNextLink(url, 1));
      next.searchParams.append('$skiptoken', 'also-present');
      return next.toString();
    },
  ];

  for (const invalidLink of invalidLinks) {
    let calls = 0;
    const client = clientWith(async (url) => {
      calls += 1;
      return jsonResponse(200, { value: [], '@odata.nextLink': invalidLink(url) });
    });
    await assert.rejects(
      client.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
    );
    assert.equal(calls, 1);
  }
});

test('room discovery enforces page bounds and rejects cross-page room identity ambiguity', async () => {
  let pages = 0;
  const pageBound = clientWith(async (url) => {
    pages += 1;
    return jsonResponse(200, {
      value: [],
      '@odata.nextLink': roomNextLink(url, pages, '$skiptoken'),
    });
  });
  await assert.rejects(
    pageBound.discoverRooms({ tenantReference: TENANT_A }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_ROOM_PAGE_LIMIT_EXCEEDED',
  );
  assert.equal(pages, 10);

  for (const duplicate of [
    graphRoom(2, { id: 'ROOM-1' }),
    graphRoom(2, { emailAddress: 'ROOM-1@EXAMPLE.INVALID' }),
  ]) {
    let calls = 0;
    const ambiguous = clientWith(async (url) => {
      calls += 1;
      return calls === 1
        ? jsonResponse(200, {
          value: [graphRoom(1)],
          '@odata.nextLink': roomNextLink(url, 2, '$skiptoken'),
        })
        : jsonResponse(200, { value: [duplicate] });
    });
    await assert.rejects(
      ambiguous.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
    );
    assert.equal(calls, 2);
  }
});

test('room discovery accepts only the documented HTTP 200 response', async () => {
  for (const status of [201, 204]) {
    const client = clientWith(async () => status === 204
      ? new Response(null, { status })
      : jsonResponse(status, { value: [graphRoom(1)] }));
    await assert.rejects(
      client.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
    );
  }
});

test('room discovery rejects malformed required provider identity fields', async () => {
  for (const room of [
    { id: 'room-1', displayName: 'Room 1', emailAddress: null },
    graphRoom(1, { id: '   ' }),
    graphRoom(1, { displayName: ' Room 1' }),
    graphRoom(1, { emailAddress: 'x'.repeat(321) }),
    graphRoom(1, { emailAddress: ' x@example.invalid' }),
  ]) {
    const client = clientWith(async () => jsonResponse(200, { value: [room] }));
    await assert.rejects(
      () => client.discoverRooms({ tenantReference: TENANT_A }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_ROOM_RESPONSE_INVALID',
    );
  }
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
