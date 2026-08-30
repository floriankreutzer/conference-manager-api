import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPlatformEntraAuthService } from '../src/platform/identity/entra-auth-service.js';
import { createPlatformEntraClient } from '../src/platform/identity/entra-client.js';
import {
  PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME,
  readPlatformEntraTransactionCookie,
} from '../src/platform/identity/entra-transaction-cookie.js';
import { PlatformIdentityError } from '../src/platform/identity/errors.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const NEW_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const CORRELATION_ID = '66666666-6666-4666-8666-666666666666';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const REDIRECT_URI = 'https://platform.example/api/v1/platform/auth/microsoft/callback';
const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const STATE = 'S'.repeat(43);
const NONCE = 'N'.repeat(43);
const MFA_CONTEXT = 'cm-platform-mfa';
const STEP_UP_CONTEXT = 'cm-platform-step-up';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function application(overrides = {}) {
  return {
    async getAuthCodeUrl(request) {
      const url = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
      url.searchParams.set('client_id', CLIENT_ID);
      url.searchParams.set('state', request.state);
      url.searchParams.set('nonce', request.nonce);
      url.searchParams.set('code_challenge', request.codeChallenge);
      url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
      url.searchParams.set('redirect_uri', REDIRECT_URI);
      url.searchParams.set('response_mode', request.responseMode);
      url.searchParams.set('response_type', request.responseType);
      url.searchParams.set('scope', 'openid profile');
      url.searchParams.set('max_age', String(request.maxAge));
      url.searchParams.set('claims', request.claims);
      return url.toString();
    },
    async acquireTokenByCode(request) {
      return {
        idTokenClaims: {
          aud: CLIENT_ID,
          iss: `${AUTHORITY}/v2.0`,
          tid: TENANT_ID,
          oid: OPERATOR_ID,
          nonce: NONCE,
          exp: Math.floor(NOW / 1000) + 3600,
          iat: Math.floor(NOW / 1000) - 30,
          auth_time: Math.floor(NOW / 1000) - 30,
          ver: '2.0',
          acrs: [request.code === 'step-up-code' ? STEP_UP_CONTEXT : MFA_CONTEXT],
          roles: ['platform_security_admin'],
          groups: ['browser-authority-must-be-ignored'],
          ...overrides,
        },
      };
    },
  };
}

function client(providerApplication = application()) {
  return createPlatformEntraClient({
    clientId: CLIENT_ID,
    clientSecret: 'platform-client-secret-test-value-at-least-32-bytes',
    tenantReference: TENANT_ID,
    authority: AUTHORITY,
    redirectUri: REDIRECT_URI,
    publicOrigin: 'https://platform.example',
    mfaAuthenticationContext: MFA_CONTEXT,
    stepUpAuthenticationContext: STEP_UP_CONTEXT,
    authenticationMaxAgeSeconds: 900,
    clock: () => NOW,
    application: providerApplication,
  });
}

function platformIdentity({ assurance = 'mfa' } = {}) {
  const roles = [PLATFORM_ROLE.SUPPORT_READER];
  return {
    operatorId: OPERATOR_ID,
    providerIdentity: {
      provider: 'microsoft_entra_platform',
      tenantReference: TENANT_ID,
      subjectReference: OPERATOR_ID,
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,
    targetScope: { mode: 'allowlist', securityVersion: 1 },
    assurance: {
      level: assurance,
      authenticationContext: assurance === 'step_up' ? STEP_UP_CONTEXT : MFA_CONTEXT,
      authenticatedAt: '2026-08-28T11:59:30.000Z',
    },
  };
}

function principal() {
  return {
    ...platformIdentity(),
    session: {
      id: SESSION_ID,
      issuedAt: '2026-08-28T11:59:30.000Z',
      expiresAt: '2026-08-28T15:59:30.000Z',
      securityVersion: 1,
      securityEpoch: 7,
      stepUpExpiresAt: null,
    },
  };
}

function memoryRepository() {
  const records = new Map();
  return {
    records,
    async create(record) { records.set(record.stateHash, { ...record }); },
    async consume({ stateHash, securityEpoch }) {
      const record = records.get(stateHash);
      if (!record || record.securityEpoch !== securityEpoch) return null;
      records.delete(stateHash);
      return {
        nonceHash: record.nonceHash,
        purpose: record.purpose,
        expectedOperatorId: record.expectedOperatorId,
        expectedSessionId: record.expectedSessionId,
        expectedSecurityVersion: record.expectedSecurityVersion,
        securityEpoch: record.securityEpoch,
        authenticationContext: record.authenticationContext,
        correlationId: record.correlationId,
      };
    },
  };
}

function tokens() {
  const values = [STATE, NONCE];
  return () => values.shift();
}

function authHarness({ repository = memoryRepository(), currentPrincipal = principal() } = {}) {
  const failures = [];
  const calls = { issued: 0, rotated: 0 };
  const provider = {
    async authorizationUrl({ state }) { return `${AUTHORITY}/oauth2/v2.0/authorize?state=${state}`; },
    async redeemAuthorizationCode({ code: codeValue, authenticationContext }) {
      return { code: codeValue, assurance: authenticationContext === STEP_UP_CONTEXT ? 'step_up' : 'mfa' };
    },
  };
  const service = createPlatformEntraAuthService({
    repository,
    entraClient: provider,
    identityService: {
      async verify(assertion) { return platformIdentity({ assurance: assertion.assurance }); },
    },
    sessionService: {
      async issue(identity) {
        calls.issued += 1;
        return { principal: { ...principal(), ...identity }, setCookie: 'platform-session=issued', csrfToken: 'csrf-issued' };
      },
      async rotate(_current, identity) {
        calls.rotated += 1;
        return {
          principal: {
            ...principal(),
            ...identity,
            session: {
              ...principal().session,
              id: NEW_SESSION_ID,
              issuedAt: '2026-08-28T12:00:00.000Z',
              stepUpExpiresAt: '2026-08-28T12:04:30.000Z',
            },
          },
          setCookie: 'platform-session=stepped-up',
          csrfToken: 'csrf-stepped-up',
        };
      },
      async resolvePrincipal() { return currentPrincipal; },
    },
    auditService: {
      createUnmappedAuthenticationFailure(value) { return value; },
      createDeniedEvent(value) { return { ...value, actorAttributed: true }; },
      async record(value) { failures.push(value); },
    },
    transactionSecret: 'platform-oidc-transaction-test-secret-at-least-32-bytes',
    publicOrigin: 'https://platform.example',
    securityEpoch: 7,
    mfaAuthenticationContext: MFA_CONTEXT,
    stepUpAuthenticationContext: STEP_UP_CONTEXT,
    randomToken: tokens(),
    idFactory: () => CORRELATION_ID,
  });
  return { service, repository, failures, calls };
}

function binding(setCookie) {
  return setCookie.split(';')[0].split('=')[1];
}

test('Platform Entra adapter fixes workforce Tenant, audience, nonce, and auth context', async () => {
  const adapter = client();
  const url = await adapter.authorizationUrl({
    state: STATE,
    nonce: NONCE,
    codeChallenge: 'C'.repeat(43),
    authenticationContext: MFA_CONTEXT,
  });
  assert.equal(new URL(url).origin, 'https://login.microsoftonline.com');
  assert.equal(new URL(url).pathname, `/${TENANT_ID}/oauth2/v2.0/authorize`);
  assert.equal(new URL(url).searchParams.get('max_age'), '900');
  const assertion = await adapter.redeemAuthorizationCode({
    code: 'login-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
    authenticationContext: MFA_CONTEXT,
  });
  const verified = await adapter.verify(assertion);
  assert.deepEqual(verified.claims, {
    provider: 'microsoft_entra_platform',
    issuer: `${AUTHORITY}/v2.0`,
    audience: CLIENT_ID,
    tenantReference: TENANT_ID,
    subjectReference: OPERATOR_ID,
    authenticationContext: MFA_CONTEXT,
    authenticatedAt: '2026-08-28T11:59:30.000Z',
  });
  await assert.rejects(adapter.verify({ claims: verified.claims }), PlatformIdentityError);

  const stepUpUrl = await adapter.authorizationUrl({
    state: STATE,
    nonce: NONCE,
    codeChallenge: 'C'.repeat(43),
    authenticationContext: STEP_UP_CONTEXT,
  });
  assert.equal(new URL(stepUpUrl).searchParams.get('max_age'), '0');
  await assert.rejects(client(application({
    auth_time: Math.floor(NOW / 1000) - 61,
  })).redeemAuthorizationCode({
    code: 'step-up-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
    authenticationContext: STEP_UP_CONTEXT,
  }), /PLATFORM_ENTRA_AUTHENTICATION_NOT_FRESH/);
});

test('Platform Entra adapter rejects customer Tenant, issuer, audience, nonce, context, and stale assurance claims', async () => {
  const cases = [
    { tid: '77777777-7777-4777-8777-777777777777' },
    { iss: 'https://login.microsoftonline.com/customer/v2.0' },
    { aud: '77777777-7777-4777-8777-777777777777' },
    { nonce: 'wrong' },
    { acrs: ['unreviewed-context'] },
    { auth_time: Math.floor(NOW / 1000) + 120 },
    { auth_time: Math.floor(NOW / 1000) - 961 },
    { auth_time: undefined },
  ];
  for (const overrides of cases) {
    await assert.rejects(client(application(overrides)).redeemAuthorizationCode({
      code: 'login-code',
      codeVerifier: 'V'.repeat(43),
      expectedNonceHash: hash(NONCE),
      authenticationContext: MFA_CONTEXT,
    }), PlatformIdentityError);
  }
  assert.throws(() => createPlatformEntraClient({
    clientId: CLIENT_ID,
    clientSecret: 'platform-client-secret-test-value-at-least-32-bytes',
    tenantReference: TENANT_ID,
    authority: 'https://login.microsoftonline.com/organizations',
    redirectUri: REDIRECT_URI,
    publicOrigin: 'https://platform.example',
    mfaAuthenticationContext: MFA_CONTEXT,
    stepUpAuthenticationContext: STEP_UP_CONTEXT,
    application: application(),
  }), /PLATFORM_ENTRA_AUTHORITY_INVALID/);
  assert.throws(() => createPlatformEntraClient({
    clientId: CLIENT_ID,
    clientSecret: 'platform-client-secret-test-value-at-least-32-bytes',
    tenantReference: TENANT_ID,
    authority: AUTHORITY,
    redirectUri: 'https://other.example/api/v1/platform/auth/microsoft/callback',
    publicOrigin: 'https://platform.example',
    mfaAuthenticationContext: MFA_CONTEXT,
    stepUpAuthenticationContext: STEP_UP_CONTEXT,
    application: application(),
  }), /PLATFORM_ENTRA_REDIRECT_INVALID/);
});

test('authorization redirect rejects provider output that drops or replaces state, nonce, PKCE, client, or callback', async () => {
  for (const parameter of [
    'client_id', 'state', 'nonce', 'code_challenge', 'code_challenge_method',
    'redirect_uri', 'response_mode', 'response_type', 'scope', 'max_age', 'claims',
  ]) {
    const provider = application();
    const original = provider.getAuthCodeUrl;
    provider.getAuthCodeUrl = async (request) => {
      const url = new URL(await original(request));
      url.searchParams.delete(parameter);
      return url.toString();
    };
    await assert.rejects(client(provider).authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: 'C'.repeat(43),
      authenticationContext: MFA_CONTEXT,
    }), PlatformIdentityError);
  }
  for (const mutate of [
    (url) => url.searchParams.append('redirect_uri', 'https://attacker.example/callback'),
    (url) => url.searchParams.set('resource', 'unexpected-resource'),
    (url) => url.searchParams.set('scope', 'openid profile offline_access'),
    (url) => url.searchParams.set('response_type', 'token'),
  ]) {
    const provider = application();
    const original = provider.getAuthCodeUrl;
    provider.getAuthCodeUrl = async (request) => {
      const url = new URL(await original(request));
      mutate(url);
      return url.toString();
    };
    await assert.rejects(client(provider).authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: 'C'.repeat(43),
      authenticationContext: MFA_CONTEXT,
    }), PlatformIdentityError);
  }
});

test('dedicated Platform OIDC transaction cookie is callback-scoped, one-time, and customer-cookie isolated', async () => {
  const harness = authHarness();
  const started = await harness.service.start({ purpose: 'login', correlationId: CORRELATION_ID });
  assert.match(started.setCookie, /^cm_platform_oidc_tx=/);
  assert.match(started.setCookie, /Path=\/api\/v1\/platform\/auth\/microsoft\/callback/);
  assert.match(started.setCookie, /HttpOnly; SameSite=Lax; Secure/);
  assert.equal(readPlatformEntraTransactionCookie({ cookie: 'cm_oidc_tx=' + 'A'.repeat(43) }), null);
  assert.equal(readPlatformEntraTransactionCookie({ cookie: started.setCookie }), binding(started.setCookie));
  assert.equal(readPlatformEntraTransactionCookie({
    cookie: `${PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME}=${'A'.repeat(43)}; ${PLATFORM_ENTRA_TRANSACTION_COOKIE_NAME}=${'B'.repeat(43)}`,
  }), null);
  const stored = [...harness.repository.records.values()][0];
  assert.equal(stored.stateHash, hash(STATE));
  assert.equal(stored.nonceHash, hash(NONCE));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(STATE));

  const completed = await harness.service.complete({
    request: {},
    state: STATE,
    code: 'login-code',
    browserBinding: binding(started.setCookie),
    correlationId: CORRELATION_ID,
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(harness.calls.issued, 1);
  await assert.rejects(harness.service.complete({
    request: {}, state: STATE, code: 'replay', browserBinding: binding(started.setCookie),
  }), /PLATFORM_OIDC_STATE_INVALID/);
});

test('browser binding is checked before state consumption and provider rejection consumes state safely', async () => {
  const harness = authHarness();
  const started = await harness.service.start();
  await assert.rejects(harness.service.complete({
    state: STATE,
    code: 'login-code',
    browserBinding: 'B'.repeat(43),
  }), /PLATFORM_OIDC_BROWSER_BINDING_INVALID/);
  assert.equal(harness.repository.records.size, 1);
  const rejected = await harness.service.complete({
    state: STATE,
    providerError: 'access_denied',
    browserBinding: binding(started.setCookie),
  });
  assert.deepEqual(rejected, { status: 'authentication_rejected' });
  assert.equal(harness.repository.records.size, 0);
  assert.deepEqual(harness.failures.map((entry) => entry.reasonCode), [
    'browser_binding_invalid',
    'provider_rejected',
  ]);
});

test('step-up transaction binds operator, current session, version, epoch, and verified context', async () => {
  const harness = authHarness();
  const started = await harness.service.start({ purpose: 'step_up', principal: principal() });
  const completed = await harness.service.complete({
    request: { headers: { cookie: 'cm_platform_session=opaque' } },
    state: STATE,
    code: 'step-up-code',
    browserBinding: binding(started.setCookie),
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(harness.calls.rotated, 1);

  const switched = authHarness({ currentPrincipal: { ...principal(), operatorId: NEW_SESSION_ID } });
  const switchedStart = await switched.service.start({ purpose: 'step_up', principal: principal() });
  await assert.rejects(switched.service.complete({
    request: {},
    state: STATE,
    code: 'step-up-code',
    browserBinding: binding(switchedStart.setCookie),
  }), /PLATFORM_OIDC_STEP_UP_BINDING_INVALID/);
  assert.equal(switched.calls.rotated, 0);
});
