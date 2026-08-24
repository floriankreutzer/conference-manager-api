import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MICROSOFT365_VERIFICATION,
  Microsoft365ProviderError,
  createMicrosoft365Client,
} from '../src/integrations/microsoft365-client.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const STATE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ACCESS_TOKEN = 'T'.repeat(128);

function response(status, payload) {
  const text = JSON.stringify(payload);
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(Buffer.byteLength(text)) : null },
    async text() { return text; },
  };
}

function client({ fetchImpl, acquire } = {}) {
  return createMicrosoft365Client({
    clientId: CLIENT_ID,
    clientSecret: 'secret-value-for-test-only-not-a-production-credential',
    publicOrigin: 'https://conference.example',
    fetchImpl: fetchImpl || (async () => response(200, { value: [] })),
    applicationFactory({ authority }) {
      assert.equal(authority, `https://login.microsoftonline.com/${TENANT_ID}`);
      return {
        async acquireTokenByClientCredential(request) {
          assert.deepEqual(request.scopes, ['https://graph.microsoft.com/.default']);
          return acquire ? acquire() : { accessToken: ACCESS_TOKEN };
        },
      };
    },
  });
}

test('admin consent URL is tenant-specific, fixed-origin and requests Graph application permissions through .default', () => {
  const api = client();
  const value = new URL(api.adminConsentUrl({ tenantReference: TENANT_ID, state: STATE }));
  assert.equal(value.origin, 'https://login.microsoftonline.com');
  assert.equal(value.pathname, `/${TENANT_ID}/v2.0/adminconsent`);
  assert.equal(value.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(value.searchParams.get('scope'), 'https://graph.microsoft.com/.default');
  assert.equal(value.searchParams.get('redirect_uri'), 'https://conference.example/api/v1/integrations/microsoft365/callback');
  assert.equal(value.searchParams.get('state'), STATE);
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
  const result = await api.verifyBasePermissions({ tenantReference: TENANT_ID, claimantUserReference: USER_ID });
  assert.deepEqual(result, {
    status: MICROSOFT365_VERIFICATION.CONNECTED,
    places: 'granted',
    calendars: 'granted',
    reason: null,
  });
  assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/places\/microsoft\.graph\.room\?/);
  assert.match(calls[1].url, new RegExp(`^https://graph\\.microsoft\\.com/v1\\.0/users/${USER_ID}/calendar\\?`));
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
});

test('permission and authorization failures are classified without returning provider payloads', async () => {
  const missingPlaces = client({ fetchImpl: async () => response(403, { error: { message: 'sensitive' } }) });
  assert.deepEqual(
    await missingPlaces.verifyBasePermissions({ tenantReference: TENANT_ID, claimantUserReference: USER_ID }),
    {
      status: MICROSOFT365_VERIFICATION.DEGRADED,
      places: 'missing',
      calendars: 'unknown',
      reason: 'places_permission_missing',
    },
  );

  const revoked = client({ fetchImpl: async () => response(401, { error: { message: 'sensitive' } }) });
  assert.equal(
    (await revoked.verifyBasePermissions({ tenantReference: TENANT_ID })).status,
    MICROSOFT365_VERIFICATION.REVOKED,
  );

  const tokenFailure = client({ acquire: () => { throw new Error('provider detail'); } });
  assert.deepEqual(
    await tokenFailure.verifyBasePermissions({ tenantReference: TENANT_ID }),
    {
      status: MICROSOFT365_VERIFICATION.REVOKED,
      places: 'unknown',
      calendars: 'unknown',
      reason: 'token_unavailable',
    },
  );
});

test('calendar probe distinguishes permission denial from a claimant without an Exchange calendar', async () => {
  let call = 0;
  const missingCalendar = client({
    fetchImpl: async () => {
      call += 1;
      return call === 1 ? response(200, { value: [] }) : response(403, {});
    },
  });
  assert.deepEqual(
    await missingCalendar.verifyBasePermissions({ tenantReference: TENANT_ID, claimantUserReference: USER_ID }),
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
    await noMailbox.verifyBasePermissions({ tenantReference: TENANT_ID, claimantUserReference: USER_ID }),
    {
      status: MICROSOFT365_VERIFICATION.CONNECTED,
      places: 'granted',
      calendars: 'unverified',
      reason: null,
    },
  );
});

test('malformed tenant, state and insecure callback origin fail before provider transport', () => {
  const api = client();
  assert.throws(
    () => api.adminConsentUrl({ tenantReference: 'browser-tenant', state: STATE }),
    (error) => error instanceof Microsoft365ProviderError && error.code === 'MICROSOFT365_TENANT_INVALID',
  );
  assert.throws(
    () => api.adminConsentUrl({ tenantReference: TENANT_ID, state: 'short' }),
    (error) => error instanceof Microsoft365ProviderError && error.code === 'MICROSOFT365_CONSENT_STATE_INVALID',
  );
  assert.throws(
    () => createMicrosoft365Client({
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      publicOrigin: 'http://conference.example',
      fetchImpl: async () => response(200, {}),
    }),
    /MICROSOFT365_PUBLIC_ORIGIN_INVALID/,
  );
});
