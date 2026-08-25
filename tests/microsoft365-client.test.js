import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MICROSOFT365_BASE_PERMISSIONS,
  MICROSOFT365_VERIFICATION,
  Microsoft365ProviderError,
  createMicrosoft365Client,
} from '../src/integrations/microsoft365-client.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const STATE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ACCESS_TOKEN = 'T'.repeat(128);

function response(status, payload, { contentLength, raw, omitContentLength = false } = {}) {
  const text = raw ?? JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (!omitContentLength) {
    headers['Content-Length'] = String(contentLength ?? Buffer.byteLength(text));
  }
  return new Response(text, { status, headers });
}

function client({
  fetchImpl,
  acquire,
  publicOrigin = 'https://conference.example',
  allowInsecureLocalhost,
  onApplicationConfiguration,
} = {}) {
  return createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'secret-value-for-test-only-not-a-production-credential',
    publicOrigin,
    allowInsecureLocalhost,
    fetchImpl: fetchImpl || (async () => response(200, { value: [] })),
    applicationFactory(configuration) {
      assert.equal(configuration.authority, `https://login.microsoftonline.com/${TENANT_ID}`);
      onApplicationConfiguration?.(configuration);
      return {
        async acquireTokenByClientCredential(request) {
          assert.deepEqual(request.scopes, ['https://graph.microsoft.com/.default']);
          return acquire ? acquire() : { accessToken: ACCESS_TOKEN };
        },
      };
    },
  });
}

test('admin consent URL is tenant-specific, fixed-origin and requests reviewed Graph application permissions', () => {
  assert.deepEqual(MICROSOFT365_BASE_PERMISSIONS, [
    'Place.Read.All',
    'Calendars.ReadBasic.All',
  ]);
  const api = client();
  const value = new URL(api.adminConsentUrl({ tenantReference: TENANT_ID, state: STATE }));
  assert.equal(value.origin, 'https://login.microsoftonline.com');
  assert.equal(value.pathname, `/${TENANT_ID}/v2.0/adminconsent`);
  assert.equal(value.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(value.searchParams.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(
    value.searchParams.get('redirect_uri'),
    'https://conference.example/api/v1/integrations/microsoft365/callback',
  );
  assert.equal(value.searchParams.get('state'), STATE);
});

test('MSAL identity transport is fixed-origin, redirect-disabled, timeout-bound and response-bounded', async () => {
  const calls = [];
  let identityMode = 'ok';
  let networkClient;
  const api = client({
    onApplicationConfiguration(configuration) {
      networkClient = configuration.networkClient;
    },
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      calls.push({ target, options });
      if (target.origin === 'https://graph.microsoft.com') {
        return response(200, { value: [] });
      }
      if (identityMode === 'oversized') {
        return response(200, { ok: true }, { contentLength: 65_537 });
      }
      if (identityMode === 'wait') {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
      }
      return response(200, { ok: true });
    },
  });

  await api.verifyBasePermissions({ tenantReference: TENANT_ID });
  assert.equal(typeof networkClient?.sendPostRequestAsync, 'function');

  const tokenUrl = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const tokenResponse = await networkClient.sendPostRequestAsync(tokenUrl, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'client_id=test',
  });
  assert.equal(tokenResponse.status, 200);
  assert.deepEqual(tokenResponse.body, { ok: true });
  const identityCall = calls.at(-1);
  assert.equal(identityCall.target.origin, 'https://login.microsoftonline.com');
  assert.equal(identityCall.options.method, 'POST');
  assert.equal(identityCall.options.redirect, 'error');
  assert.equal(identityCall.options.signal instanceof AbortSignal, true);

  const callCount = calls.length;
  await assert.rejects(
    networkClient.sendPostRequestAsync('https://attacker.example/token', { body: '' }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_IDENTITY_URL_INVALID',
  );
  assert.equal(calls.length, callCount);

  await assert.rejects(
    networkClient.sendPostRequestAsync(tokenUrl, { body: 'x'.repeat(65_537) }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_IDENTITY_REQUEST_INVALID',
  );
  assert.equal(calls.length, callCount);

  await assert.rejects(
    networkClient.sendPostRequestAsync(tokenUrl, {
      headers: { 'X-Test': 'value\r\ninjected: true' },
      body: '',
    }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_IDENTITY_REQUEST_INVALID',
  );
  assert.equal(calls.length, callCount);

  identityMode = 'oversized';
  await assert.rejects(
    networkClient.sendPostRequestAsync(tokenUrl, { body: '' }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_RESPONSE_TOO_LARGE',
  );

  identityMode = 'wait';
  await assert.rejects(
    networkClient.sendGetRequestAsync(
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0/.well-known/openid-configuration`,
      undefined,
      1,
    ),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_IDENTITY_UNAVAILABLE',
  );
});

test('base permission verification uses fixed Graph destinations and validates both read capabilities', async () => {
  const calls = [];
  const api = client({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return response(200, { value: [{ id: 'room-id' }] });
      return response(200, { id: 'calendar-id' });
    },
  });
  const result = await api.verifyBasePermissions({
    tenantReference: TENANT_ID,
    claimantUserReference: USER_ID,
  });
  assert.deepEqual(result, {
    status: MICROSOFT365_VERIFICATION.CONNECTED,
    places: 'granted',
    calendars: 'granted',
    reason: null,
  });
  assert.match(
    calls[0].url,
    /^https:\/\/graph\.microsoft\.com\/v1\.0\/places\/microsoft\.graph\.room\?/,
  );
  assert.match(
    calls[1].url,
    new RegExp(`^https://graph\\.microsoft\\.com/v1\\.0/users/${USER_ID}/calendar\\?`),
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test('a missing claimant identity degrades calendar verification without making a broad Graph call', async () => {
  const calls = [];
  const api = client({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return response(200, { value: [] });
    },
  });
  assert.deepEqual(
    await api.verifyBasePermissions({ tenantReference: TENANT_ID }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'granted',
      calendars: 'unverified',
      reason: 'calendars_permission_unverified',
    },
  );
  assert.equal(calls.length, 1);
});

test('permission and authorization failures are classified without returning provider payloads', async () => {
  const missingPlaces = client({
    fetchImpl: async () => response(403, { error: { message: 'sensitive' } }),
  });
  assert.deepEqual(
    await missingPlaces.verifyBasePermissions({ tenantReference: TENANT_ID, claimantUserReference: USER_ID }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'missing',
      calendars: 'unknown',
      reason: 'places_permission_missing',
    },
  );

  const revoked = client({
    fetchImpl: async () => response(401, { error: { message: 'sensitive' } }),
  });
  assert.equal(
    (await revoked.verifyBasePermissions({ tenantReference: TENANT_ID })).status,
    MICROSOFT365_VERIFICATION.REVOKED,
  );

  const tokenFailure = client({ acquire: () => { throw new Error('provider detail'); } });
  assert.deepEqual(
    await tokenFailure.verifyBasePermissions({ tenantReference: TENANT_ID }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'unknown',
      calendars: 'unknown',
      reason: 'provider_unavailable',
    },
  );

  const invalidToken = client({ acquire: () => ({ accessToken: 'short' }) });
  assert.deepEqual(
    await invalidToken.verifyBasePermissions({ tenantReference: TENANT_ID }),
    {
      status: MICROSOFT365_VERIFICATION.REVOKED,
      places: 'unknown',
      calendars: 'unknown',
      reason: 'token_invalid',
    },
  );
});

test('calendar probe distinguishes permission denial from an unavailable Exchange calendar', async () => {
  let call = 0;
  const missingCalendar = client({
    fetchImpl: async () => {
      call += 1;
      return call === 1 ? response(200, { value: [] }) : response(403, {});
    },
  });
  assert.deepEqual(
    await missingCalendar.verifyBasePermissions({
      tenantReference: TENANT_ID,
      claimantUserReference: USER_ID,
    }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'granted',
      calendars: 'missing',
      reason: 'calendars_permission_missing',
    },
  );

  call = 0;
  const noMailbox = client({
    fetchImpl: async () => {
      call += 1;
      return call === 1 ? response(200, { value: [] }) : response(404, {});
    },
  });
  assert.deepEqual(
    await noMailbox.verifyBasePermissions({
      tenantReference: TENANT_ID,
      claimantUserReference: USER_ID,
    }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'granted',
      calendars: 'unverified',
      reason: 'calendars_permission_unverified',
    },
  );
});

test('transport, malformed and oversized provider responses degrade without escaping provider detail', async () => {
  const cases = [
    {
      fetchImpl: async () => { throw new Error('network with secret'); },
      reason: 'provider_unavailable',
    },
    {
      fetchImpl: async () => response(200, null, { raw: '<html>provider error</html>' }),
      reason: 'provider_response_invalid',
    },
    {
      fetchImpl: async () => response(200, { value: [] }, { contentLength: 65_537 }),
      reason: 'provider_response_invalid',
    },
    {
      fetchImpl: async () => response(200, { value: [] }, {
        raw: 'x'.repeat(65_537),
        omitContentLength: true,
      }),
      reason: 'provider_response_invalid',
    },
    {
      fetchImpl: async () => response(200, { unexpected: [] }),
      reason: 'provider_response_invalid',
    },
    {
      fetchImpl: async () => response(200, { value: [{ id: 12 }] }),
      reason: 'provider_response_invalid',
    },
    {
      fetchImpl: async () => response(429, { error: { message: 'throttled' } }),
      reason: 'provider_unavailable',
    },
    {
      fetchImpl: async () => response(503, { error: { message: 'downstream' } }),
      reason: 'provider_unavailable',
    },
  ];

  for (const value of cases) {
    const result = await client({ fetchImpl: value.fetchImpl }).verifyBasePermissions({
      tenantReference: TENANT_ID,
    });
    assert.deepEqual(result, {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'unknown',
      calendars: 'unknown',
      reason: value.reason,
    });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(JSON.stringify(result).includes('provider error'), false);
  }
});

test('oversized chunked provider responses are cancelled as soon as the response bound is exceeded', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(40_000));
      controller.enqueue(new Uint8Array(40_000));
      controller.enqueue(new Uint8Array(40_000));
    },
    cancel() {
      cancelled = true;
    },
  });
  const api = client({
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });

  assert.deepEqual(
    await api.verifyBasePermissions({ tenantReference: TENANT_ID }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'unknown',
      calendars: 'unknown',
      reason: 'provider_response_invalid',
    },
  );
  assert.equal(cancelled, true);
});

test('malformed tenant, state and unapproved callback origins fail before provider transport', () => {
  const api = client();
  assert.throws(
    () => api.adminConsentUrl({ tenantReference: 'browser-tenant', state: STATE }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_TENANT_INVALID',
  );
  assert.throws(
    () => api.adminConsentUrl({ tenantReference: TENANT_ID, state: 'short' }),
    (error) => error instanceof Microsoft365ProviderError
      && error.code === 'MICROSOFT365_CONSENT_STATE_INVALID',
  );
  for (const publicOrigin of [
    'http://conference.example',
    'https://conference.example/path',
    'https://user:password@conference.example',
  ]) {
    assert.throws(
      () => createMicrosoft365Client({
        clientId: CLIENT_ID,
        clientSecret: 'secret',
        publicOrigin,
        fetchImpl: async () => response(200, {}),
      }),
      /MICROSOFT365_PUBLIC_ORIGIN_INVALID/,
    );
  }

  assert.equal(
    client({
      publicOrigin: 'http://localhost:3000',
      allowInsecureLocalhost: true,
    }).redirectUri,
    'http://localhost:3000/api/v1/integrations/microsoft365/callback',
  );
});
