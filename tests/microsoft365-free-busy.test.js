import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CalendarProviderError,
  PROVIDER_ERROR_KIND,
} from '../src/integrations/calendar-contract.js';
import {
  Microsoft365ProviderError,
  createMicrosoft365Client,
} from '../src/integrations/microsoft365-client.js';
import { createMicrosoft365CalendarProviderFactory } from '../src/integrations/microsoft365-calendar-provider.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const INTEGRATION_ID = '44444444-4444-4444-8444-444444444444';
const PROVIDER_TENANT = '55555555-5555-4555-8555-555555555555';
const ACCESS_TOKEN = 'T'.repeat(128);
const ROOM_ID = 'room-a';
const ROOM_ADDRESS = 'room-a@example.com';
const STARTS_AT = '2026-10-25T00:30:00.123Z';
const ENDS_AT = '2026-10-25T02:30:00.123Z';

function response(status, payload) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
  });
}

function client(fetchImpl) {
  return createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'test-only-secret-not-a-production-credential',
    publicOrigin: 'https://conference.example',
    fetchImpl,
    applicationFactory({ authority }) {
      assert.equal(authority, `https://login.microsoftonline.com/${PROVIDER_TENANT}`);
      return {
        async acquireTokenByClientCredential(request) {
          assert.deepEqual(request.scopes, ['https://graph.microsoft.com/.default']);
          return { accessToken: ACCESS_TOKEN };
        },
      };
    },
  });
}

function connection(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    providerTenantReference: PROVIDER_TENANT,
    connectionVersion: 1,
    status: 'connected',
    calendarsPermission: 'granted',
    ...overrides,
  };
}

function mapping(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    roomId: ROOM_ID,
    integrationId: INTEGRATION_ID,
    resourceAddress: ROOM_ADDRESS,
    providerStatus: 'active',
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    provider: 'microsoft_entra',
    providerTenantReference: PROVIDER_TENANT,
    status: 'active',
    ...overrides,
  };
}

function providerFactory({
  providerClient,
  currentConnection = connection(),
  currentBinding = binding(),
  mappings = [mapping()],
} = {}) {
  return createMicrosoft365CalendarProviderFactory({
    connectionRepository: {
      async findByTenantId(tenantId) {
        assert.equal(tenantId, TENANT_ID);
        return currentConnection;
      },
    },
    bindingRepository: {
      async findActiveBindingByTenantId(tenantId, provider) {
        assert.equal(tenantId, TENANT_ID);
        assert.equal(provider, 'microsoft_entra');
        return currentBinding;
      },
    },
    mappingRepository: {
      async listByTenantIdAndIntegrationId(tenantId, integrationId) {
        assert.equal(tenantId, TENANT_ID);
        assert.equal(integrationId, INTEGRATION_ID);
        return mappings;
      },
    },
    providerClient: providerClient || {
      async lookupFreeBusy() {
        return [{ schedule: ROOM_ADDRESS, available: true, conflictCount: 0 }];
      },
    },
  });
}

test('Graph getSchedule uses a fixed endpoint, UTC normalization and returns free/busy only', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(200, {
      value: [{
        scheduleId: ROOM_ADDRESS,
        availabilityView: '000000000000000000000000',
        scheduleItems: [{ subject: 'must-not-cross-boundary' }],
      }],
    });
  });

  const result = await api.lookupFreeBusy({
    tenantReference: PROVIDER_TENANT,
    schedules: [ROOM_ADDRESS],
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
  });

  assert.deepEqual(result, [{ schedule: ROOM_ADDRESS, available: true, conflictCount: 0 }]);
  assert.equal(JSON.stringify(result).includes('must-not-cross-boundary'), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, 'https://graph.microsoft.com');
  assert.equal(
    calls[0].url.pathname,
    `/v1.0/users/${encodeURIComponent(ROOM_ADDRESS)}/calendar/getSchedule`,
  );
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[0].options.headers.Prefer, 'outlook.timezone="UTC"');
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    schedules: [ROOM_ADDRESS],
    startTime: { dateTime: '2026-10-25T00:30:00.123', timeZone: 'UTC' },
    endTime: { dateTime: '2026-10-25T02:30:00.123', timeZone: 'UTC' },
    availabilityViewInterval: 5,
  });
});

test('all non-free Graph availability states fail closed as conflicts and batching is bounded', async () => {
  const schedules = Array.from({ length: 20 }, (_, index) => `room-${index}@example.com`);
  const availabilityView = ['0', '1', '2', '3', '4'];
  const api = client(async () => response(200, {
    value: schedules.map((scheduleId, index) => ({
      scheduleId,
      availabilityView: availabilityView[index % availabilityView.length].repeat(12),
    })),
  }));

  const result = await api.lookupFreeBusy({
    tenantReference: PROVIDER_TENANT,
    schedules,
    startsAt: '2026-08-25T08:00:00Z',
    endsAt: '2026-08-25T09:00:00Z',
  });
  assert.equal(result.length, 20);
  assert.deepEqual(result[0], { schedule: schedules[0], available: true, conflictCount: 0 });
  for (const entry of result.slice(1, 5)) {
    assert.deepEqual(entry, { schedule: entry.schedule, available: false, conflictCount: 1 });
  }

  await assert.rejects(
    api.lookupFreeBusy({
      tenantReference: PROVIDER_TENANT,
      schedules: [...schedules, 'room-20@example.com'],
      startsAt: '2026-08-25T08:00:00Z',
      endsAt: '2026-08-25T09:00:00Z',
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_FREE_BUSY_REQUEST_INVALID',
  );
});

test('free/busy rejects ambiguous time zones, oversized windows and duplicate schedules before Graph transport', async () => {
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return response(200, { value: [] });
  });
  const invalidInputs = [
    {
      schedules: [ROOM_ADDRESS],
      startsAt: '2026-08-25T08:00:00+02:00',
      endsAt: '2026-08-25T09:00:00+02:00',
    },
    {
      schedules: [ROOM_ADDRESS],
      startsAt: '2026-08-25T08:00:00Z',
      endsAt: '2026-09-02T08:00:01Z',
    },
    {
      schedules: [ROOM_ADDRESS, ROOM_ADDRESS.toUpperCase()],
      startsAt: '2026-08-25T08:00:00Z',
      endsAt: '2026-08-25T09:00:00Z',
    },
  ];
  for (const input of invalidInputs) {
    await assert.rejects(
      api.lookupFreeBusy({ tenantReference: PROVIDER_TENANT, ...input }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_FREE_BUSY_REQUEST_INVALID',
    );
  }
  assert.equal(calls, 0);
});

test('provider dependency failures and malformed payloads never become available', async () => {
  const cases = [
    [401, 'MICROSOFT365_GRAPH_UNAUTHORIZED'],
    [403, 'MICROSOFT365_GRAPH_PERMISSION_MISSING'],
    [429, 'MICROSOFT365_GRAPH_THROTTLED'],
    [503, 'MICROSOFT365_GRAPH_UNAVAILABLE'],
  ];
  for (const [status, code] of cases) {
    const api = client(async () => response(status, { error: { message: 'sensitive provider detail' } }));
    await assert.rejects(
      api.lookupFreeBusy({
        tenantReference: PROVIDER_TENANT,
        schedules: [ROOM_ADDRESS],
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
      }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === code
        && !error.message.includes('sensitive provider detail'),
    );
  }

  const malformed = client(async () => response(200, {
    value: [{ scheduleId: ROOM_ADDRESS, availabilityView: '00X00' }],
  }));
  await assert.rejects(
    malformed.lookupFreeBusy({
      tenantReference: PROVIDER_TENANT,
      schedules: [ROOM_ADDRESS],
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_FREE_BUSY_RESPONSE_INVALID',
  );
});

test('free/busy requires the exact five-minute slot count for the UTC window', async () => {
  for (const availabilityView of ['0', '0'.repeat(287), '0'.repeat(289)]) {
    const api = client(async () => response(200, {
      value: [{ scheduleId: ROOM_ADDRESS, availabilityView }],
    }));
    await assert.rejects(
      api.lookupFreeBusy({
        tenantReference: PROVIDER_TENANT,
        schedules: [ROOM_ADDRESS],
        startsAt: '2026-10-25T00:00:00.000Z',
        endsAt: '2026-10-26T00:00:00.000Z',
      }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_FREE_BUSY_RESPONSE_INVALID',
    );
  }

  const exact = client(async () => response(200, {
    value: [{ scheduleId: ROOM_ADDRESS, availabilityView: '0'.repeat(288) }],
  }));
  assert.deepEqual(
    await exact.lookupFreeBusy({
      tenantReference: PROVIDER_TENANT,
      schedules: [ROOM_ADDRESS],
      startsAt: '2026-10-25T00:00:00.000Z',
      endsAt: '2026-10-26T00:00:00.000Z',
    }),
    [{ schedule: ROOM_ADDRESS, available: true, conflictCount: 0 }],
  );

  const partialSlot = client(async () => response(200, {
    value: [{ scheduleId: ROOM_ADDRESS, availabilityView: '000' }],
  }));
  assert.equal((await partialSlot.lookupFreeBusy({
    tenantReference: PROVIDER_TENANT,
    schedules: [ROOM_ADDRESS],
    startsAt: '2026-10-25T00:00:00.000Z',
    endsAt: '2026-10-25T00:10:01.000Z',
  }))[0].available, true);
});

test('free/busy accepts only the documented HTTP 200 response', async () => {
  for (const status of [201, 204]) {
    const api = client(async () => status === 204
      ? new Response(null, { status })
      : response(status, {
        value: [{ scheduleId: ROOM_ADDRESS, availabilityView: '0'.repeat(24) }],
      }));
    await assert.rejects(
      api.lookupFreeBusy({
        tenantReference: PROVIDER_TENANT,
        schedules: [ROOM_ADDRESS],
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
      }),
      (error) => error instanceof Microsoft365ProviderError
        && error.code === 'MICROSOFT365_FREE_BUSY_RESPONSE_INVALID',
    );
  }
});

test('Microsoft 365 calendar provider binds server-side Tenant, connection and active room mapping', async () => {
  const calls = [];
  const factory = providerFactory({
    providerClient: {
      async lookupFreeBusy(input) {
        calls.push(input);
        return [{ schedule: ROOM_ADDRESS, available: false, conflictCount: 1 }];
      },
    },
  });
  const provider = await factory.forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID });
  assert.equal(provider.integrationId, INTEGRATION_ID);
  assert.deepEqual(
    await provider.lookupAvailability({
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }),
    { schedule: ROOM_ADDRESS, available: false, conflictCount: 1 },
  );
  assert.deepEqual(calls[0], {
    tenantReference: PROVIDER_TENANT,
    schedules: [ROOM_ADDRESS],
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
  });

  await assert.rejects(
    provider.lookupAvailability({
      tenantId: OTHER_TENANT_ID,
      roomId: ROOM_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION,
  );
  assert.equal(calls.length, 1);
});

test('missing permission, inactive mappings and Graph failures are classified fail closed', async () => {
  await assert.rejects(
    providerFactory({ currentConnection: connection({ calendarsPermission: 'missing' }) })
      .forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION,
  );

  await assert.rejects(
    providerFactory({ currentBinding: null })
      .forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION,
  );

  await assert.rejects(
    providerFactory({
      currentBinding: binding({
        providerTenantReference: '66666666-6666-4666-8666-666666666666',
      }),
    }).forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.AUTHORIZATION,
  );

  await assert.rejects(
    providerFactory({ mappings: [mapping({ providerStatus: 'missing' })] })
      .forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.NOT_FOUND,
  );

  const provider = await providerFactory({
    providerClient: {
      async lookupFreeBusy() {
        throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_THROTTLED');
      },
    },
  }).forRoom({ tenantId: TENANT_ID, roomId: ROOM_ID });
  await assert.rejects(
    provider.validateReservation({
      tenantId: TENANT_ID,
      roomId: ROOM_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
    }),
    (error) => error instanceof CalendarProviderError
      && error.kind === PROVIDER_ERROR_KIND.THROTTLED
      && error.retryable === true,
  );
});
