import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createPlatformHttpServer } from '../src/platform/server.js';
import { platformPasskeyRoutes } from '../src/platform/http/passkey-routes.js';
import { platformPasskeyAuthenticationRoutes } from '../src/platform/http/passkey-authentication-routes.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createPlatformPasskeyLifecycleService } from '../src/platform/identity/passkey-lifecycle-service.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { serializePlatformEntraTransactionCookie,
  serializeClearedPlatformEntraTransactionCookie } from '../src/platform/identity/entra-transaction-cookie.js';
import { serializePlatformPasskeyTransactionCookie,
  clearPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { serializePlatformPasskeyEnrollmentCookie } from '../src/platform/identity/passkey-enrollment-cookie.js';
import { readPlatformSessionToken, serializePlatformSessionCookie } from '../src/platform/identity/session-cookie.js';

const ORIGIN = 'https://ops-int.example.com'; const BASE = '/api/v1/platform/auth/passkey';
const ID = '11111111-1111-4111-8111-111111111111'; const OTHER = '22222222-2222-4222-8222-222222222222';
const state = Buffer.alloc(32, 1).toString('base64url'); const browser = Buffer.alloc(32, 2).toString('base64url');
const authCookie = serializePlatformPasskeyTransactionCookie(`${state}.${browser}`);
const enrollCookie = serializePlatformPasskeyEnrollmentCookie(`${state}.${browser}`);
const csrf = 'C'.repeat(43); const sessionToken = 'P'.repeat(43);
const roles = ['platform_security_admin']; const now = new Date().toISOString();
const principal = { operatorId: ID,
  providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: ID, subjectReference: OTHER },
  securityVersion: 4, roles, permissions: permissionsForPlatformRoles(roles), targetScope: { mode: 'all', securityVersion: 4 },
  assurance: { level: 'mfa', authenticationContext: 'cm:pk:v1', authenticatedAt: now },
  session: { id: OTHER, securityVersion: 4, securityEpoch: 8, issuedAt: now,
    expiresAt: new Date(Date.now() + 3600000).toISOString(), stepUpExpiresAt: null } };
const options = { challenge: state, userVerification: 'required' };
const registered = () => ({ status: 'registration_required', state, options, setCookie: enrollCookie });
const asserted = () => ({ status: 'passkey_required', state, options, setCookie: authCookie });
function config() {
  return { mode: 'test', serviceVersion: '0.1.0', buildId: 'test-build', publicOrigin: ORIGIN,
    entraAuthority: `https://login.microsoftonline.com/${ID}`, entraClientId: OTHER,
    entraRedirectUri: `${ORIGIN}/api/v1/platform/auth/microsoft/callback`, mfaAuthenticationContext: 'c1',
    stepUpAuthenticationContext: 'c2', authenticationMaxAgeSeconds: 900,
    maxBodyBytes: 32768, maxResponseBytes: 65536, rateLimitMax: 1000, rateLimitWindowMs: 60000, rateLimitMaxKeys: 100,
    requestTimeoutMs: 5000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 1000 };
}
function authorizationUrl() {
  const url = new URL(`${config().entraAuthority}/oauth2/v2.0/authorize`);
  for (const [key, value] of Object.entries({ client_id: OTHER, redirect_uri: config().entraRedirectUri, scope: 'openid profile',
    response_type: 'code', response_mode: 'query', state, nonce: browser, code_challenge: state, code_challenge_method: 'S256',
    max_age: '300', claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) })) url.searchParams.set(key, value);
  return url.toString();
}
async function fixture(t, mode = 'application_passkey') {
  const calls = []; const audit = []; let authResult = null; let oidcResult = null; let keys = []; let failure = false;
  const authenticated = () => ({ status: 'authenticated', principal, csrfToken: csrf,
    setCookies: [serializePlatformSessionCookie(sessionToken, { secure: true, maxAgeSeconds: 3600 }),
      clearPlatformPasskeyTransactionCookie()] });
  function requireCookie(value) { if (!value) throw new PlatformIdentityError('PLATFORM_PASSKEY_REJECTED'); }
  const passkeys = {
    configuration: () => ({ mode, environment: 'int', minimumPasskeys: 2 }),
    async pendingAuthentication(value) { requireCookie(value); return { ...asserted(), setupRequired: mode === 'passkey_setup' }; },
    async pendingEnrollment(value) { requireCookie(value); return registered(); },
    async authenticate(value) { calls.push(['authenticate', value]); if (failure) throw new PlatformIdentityError('PRIVATE_NATIVE_DETAILS');
      return authResult ?? authenticated(); },
    async startEnrollment(value) { requireCookie(value.cookie); calls.push(['startEnrollment', value]); return registered(); },
    async register(value) { calls.push(['register', value]); return { status: 'possession_required', state, options }; },
    async completeEnrollment() { return { status: 'credential_enrolled' }; },
    async listKeys() { return { items: keys }; }, async startAddition(value) { calls.push(['startAddition', value]); return asserted(); },
    async completeAddition() { return { ...authenticated(), status: 'operation_completed', result: registered() }; },
    async startRevocation(value, id) { calls.push(['startRevocation', value, id]); return asserted(); },
    async completeRevocation() { return { status: 'reauthentication_required', result: { status: 'credential_revoked' } }; },
  };
  const server = createPlatformHttpServer({ config: config(), routeModules: [platformPasskeyAuthenticationRoutes,platformPasskeyRoutes],
    platformPasskeyService: passkeys, platformAuthService: {
      async start() { return { authorizationUrl: authorizationUrl(),
        setCookie: serializePlatformEntraTransactionCookie(browser, { maxAgeSeconds: 300 }) }; },
      async complete(value) { calls.push(['oidcComplete', value]); return oidcResult ?? asserted(); },
      clearCookie: serializeClearedPlatformEntraTransactionCookie,
    }, platformSessionService: {
      async resolvePrincipal(request) { return readPlatformSessionToken(request.headers) === sessionToken ? principal : null; },
      verifyCsrf: request => request.headers['x-csrf-token'] === csrf,
    }, platformAuditService: { createUnmappedAuthenticationFailure: value => value, createDeniedEvent: value => value,
      async record(value) { audit.push(value); } }, logger: { requestCompleted() {}, securityOutcome() {}, unhandledError() {} },
    requestIdFactory: () => OTHER });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const supplied = { Host: 'ops-int.example.com', ...(method === 'POST' ? { Origin: ORIGIN } : {}),
      ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers };
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: supplied }, incoming => {
        const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => {
          const raw = Buffer.concat(chunks).toString(); resolve({ status: incoming.statusCode, headers: incoming.headers,
            body: raw ? JSON.parse(raw) : null, raw });
        });
      });
      outgoing.on('error', reject); if (payload !== null) outgoing.write(payload); outgoing.end();
    });
  }
  return { request, calls, audit, authenticated, passkeys, setAuth: value => { authResult = value; },
    setOidc: value => { oidcResult = value; },
    setKeys: value => { keys = value; }, fail: () => { failure = true; } };
}
const preauth = { Cookie: authCookie.split(';')[0], 'X-CSRF-Token': state };
const managed = { Cookie: `cm_platform_session=${sessionToken}; ${authCookie.split(';')[0]}`, 'X-CSRF-Token': csrf };

test('Microsoft primary routes request only fresh identity and callback emits only a pending cookie', async t => {
  const f = await fixture(t); const login = await f.request('/api/v1/platform/auth/microsoft/login');
  assert.equal(login.status, 303); const location = new URL(login.headers.location);
  assert.equal(location.searchParams.get('max_age'), '300'); assert.equal(location.searchParams.get('claims').includes('acrs'), false);
  const callback = await f.request(`/api/v1/platform/auth/microsoft/callback?state=${state}&code=code`);
  assert.equal(callback.status, 303); assert.equal(callback.headers.location, `${ORIGIN}/`);
  assert.equal(callback.headers['set-cookie'].some(value => value.startsWith('cm_platform_session=')), false);
  assert.ok(callback.headers['set-cookie'].includes(authCookie));
  f.setOidc(f.authenticated());
  assert.equal((await f.request(`/api/v1/platform/auth/microsoft/callback?state=${state}&code=code`)).status, 500);
  const invalid = await f.request(`/api/v1/platform/auth/microsoft/callback?state=${state}&code=code&error_description=private`);
  assert.equal(invalid.status, 400);
});

test('Microsoft SDK callback metadata reaches only pending setup and is not forwarded as identity', async t => {
  const f = await fixture(t, 'passkey_setup');
  const path = `/api/v1/platform/auth/microsoft/callback?state=${state}&code=code&client_info=c3ludGhldGlj&session_state=${ID}`;
  const result = await f.request(path);
  assert.equal(result.status, 303);
  assert.equal(result.headers.location, `${ORIGIN}/`);
  assert.ok(result.headers['set-cookie'].includes(authCookie));
  assert.equal(result.headers['set-cookie'].some(value => value.startsWith('cm_platform_session=')), false);
  const input = f.calls.find(([name]) => name === 'oidcComplete')[1];
  assert.equal(Object.hasOwn(input, 'client_info'), false);
  assert.equal(Object.hasOwn(input, 'session_state'), false);
  for (const suffix of ['&client_info=duplicate', '&session_state=duplicate', '&tenantId=attacker']) {
    assert.equal((await f.request(path + suffix)).status, 400);
  }
  assert.equal(f.calls.filter(([name]) => name === 'oidcComplete').length, 1);
});

test('preauthentication requires exact cookie, state CSRF, Origin and positive bodies before enrollment ports', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`${BASE}/pending`)).status, 401);
  assert.equal((await f.request(`${BASE}/pending`, { headers: preauth })).status, 200);
  const body = { state, grantId: ID, token: browser };
  for (const [headers, expected] of [[{ ...preauth, Origin: 'https://foreign.example.com' },403],
    [{ ...preauth, 'X-CSRF-Token': browser },403], [{ ...preauth, 'Content-Type': 'text/plain' },415]]) {
    assert.equal((await f.request(`${BASE}/enrollment/start`, { method: 'POST', body, headers })).status, expected);
  }
  assert.equal((await f.request(`${BASE}/enrollment/start`, { method: 'POST', body: { ...body, roles: ['platform_security_admin'] },
    headers: preauth })).status, 400);
  assert.equal(f.calls.length, 0);
  const result = await f.request(`${BASE}/enrollment/start`, { method: 'POST', body, headers: preauth });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'registration_required');
  assert.deepEqual(result.headers['set-cookie'], [clearPlatformPasskeyTransactionCookie(),enrollCookie]);
  assert.equal(Object.hasOwn(result.body, 'token'), false); assert.equal(Object.hasOwn(result.body, 'principal'), false);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
});

test('setup cannot expose a normal session; active authentication returns no principal or CSRF in its response body', async t => {
  const setup = await fixture(t, 'passkey_setup');
  const body = { state, response: {} };
  const denied = await setup.request(`${BASE}/authenticate`, { method: 'POST', body, headers: preauth });
  assert.equal(denied.status, 500); assert.equal(denied.headers['set-cookie'], undefined);
  setup.setAuth(registered());
  const next = await setup.request(`${BASE}/authenticate`, { method: 'POST', body, headers: preauth });
  assert.equal(next.status, 200); assert.equal(next.body.status, 'registration_required');
  const active = await fixture(t);
  const success = await active.request(`${BASE}/authenticate`, { method: 'POST', body, headers: preauth });
  assert.equal(success.status, 200); assert.deepEqual(Object.keys(success.body).sort(), ['requestId','status']);
  assert.equal(success.headers['set-cookie'].length, 2);
});

test('key management requires Platform session/CSRF, minimizes owned data and never returns grant or strong cookie', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`${BASE}/manage/keys`)).status, 401);
  assert.equal((await f.request(`${BASE}/manage/keys`, { headers: { Cookie: `cm_session=${sessionToken}` } })).status, 401);
  const item = { id: browser, createdAt: now, lastUsedAt: null, backupEligible: false, backedUp: false }; f.setKeys([item]);
  const keys = await f.request(`${BASE}/manage/keys`, { headers: managed });
  assert.equal(keys.status, 200); assert.deepEqual(keys.body.items, [item]);
  f.setKeys([{ ...item, publicKey: 'private-internal-detail' }]);
  const invalid = await f.request(`${BASE}/manage/keys`, { headers: managed });
  assert.equal(invalid.status, 500); assert.doesNotMatch(invalid.raw, /private-internal-detail/);
  assert.equal((await f.request(`${BASE}/manage/addition/start`, { method: 'POST', body: {},
    headers: { ...managed, 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request(`${BASE}/manage/addition/start`, { method: 'POST', body: {}, headers: managed })).status, 200);
  const completed = await f.request(`${BASE}/manage/addition/complete`,
    { method: 'POST', body: { state, response: {} }, headers: managed });
  assert.equal(completed.status, 200); assert.equal(completed.body.status, 'registration_required');
  assert.equal(Object.hasOwn(completed.body, 'grant'), false); assert.equal(completed.headers['set-cookie'].length, 3);
});

test('authentication failure has a fixed error, bounded audit reason, no raw native payload and dedicated abuse limit', async t => {
  const f = await fixture(t); f.fail();
  const rejected = await f.request(`${BASE}/authenticate`, { method: 'POST', body: { state, response: {} }, headers: preauth });
  assert.equal(rejected.status, 401); assert.equal(rejected.body.error.code, 'PLATFORM_PASSKEY_REJECTED');
  assert.doesNotMatch(rejected.raw, /PRIVATE_NATIVE_DETAILS|cookie|signature/);
  assert.ok(f.audit.some(value => value.reasonCode === 'passkey_rejected'));
  for (let n = 0; n < 29; n++) assert.equal((await f.request(`${BASE}/configuration`)).status, 200);
  assert.equal((await f.request(`${BASE}/configuration`)).status, 429);
  assert.equal((await f.request('/api/v1/platform/unclaimed')).status, 404);
});

test('managed session loss after the HTTP guard is a fixed audited403 for key listing, addition and revocation', async t => {
  const f = await fixture(t); let effects = 0;
  const never = async () => { effects++; throw new Error('UNEXPECTED_PROOF_OR_KEY_ACCESS'); };
  const lifecycle = createPlatformPasskeyLifecycleService({ environment: 'int', securityEpoch: 8,
    sessionService: { async resolvePrincipal() { return null; } },
    authService: { startStepUp: never, executeStepUp: never, executeCredentialLifecycle: never },
    repository: { listActive: never, issueAdditional: never, revokeCredential: never } });
  Object.assign(f.passkeys, { listKeys: request => lifecycle.list(request),
    completeAddition: value => lifecycle.beginAddition(value, never), completeRevocation: value => lifecycle.revoke(value) });
  for (const [path, settings] of [[`${BASE}/manage/keys`, { headers: managed }],
    [`${BASE}/manage/addition/complete`, { method: 'POST', body: { state, response: {} }, headers: managed }],
    [`${BASE}/manage/revocation/complete`,
      { method: 'POST', body: { state, response: {}, credentialId: browser }, headers: managed }]]) {
    const response = await f.request(path, settings);
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'PLATFORM_PASSKEY_REJECTED');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.doesNotMatch(response.raw, /TypeError|UNEXPECTED_PROOF_OR_KEY_ACCESS|operatorId|cookie|signature/);
  }
  assert.equal(effects, 0); assert.equal(f.audit.length, 3);
  for (const event of f.audit) {
    assert.equal(event.targetType, 'platform_passkey_operation');
    assert.deepEqual(event.metadata, { reasonCode: 'passkey_rejected' });
  }
});
