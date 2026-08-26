import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createEntraAuthService } from '../src/identity/entra-auth-service.js';
import { createEntraClient, ENTRA_IDENTITY_PROVIDER } from '../src/identity/entra-client.js';
import { EntraAuthenticationError } from '../src/identity/entra-errors.js';
import {
  ENTRA_TRANSACTION_COOKIE_NAME,
  readEntraTransactionCookie,
} from '../src/identity/entra-transaction-cookie.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORITY = 'https://login.microsoftonline.com/organizations';
const PUBLIC_ORIGIN = 'https://app.example.com';
const REDIRECT_URI = `${PUBLIC_ORIGIN}/api/v1/auth/microsoft/callback`;
const TRANSACTION_SECRET = 'test-oidc-transaction-secret-at-least-32-bytes';
const NOW_MS = Date.parse('2026-08-24T12:00:00.000Z');
const STATE = 'S'.repeat(43);
const NONCE = 'N'.repeat(43);

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cookieValue(setCookie) {
  const pair = setCookie.split(';', 1)[0];
  return pair.slice(pair.indexOf('=') + 1);
}

function externalIdentity() {
  return {
    provider: ENTRA_IDENTITY_PROVIDER,
    tenantReference: TENANT_ID,
    userReference: USER_ID,
  };
}

function memoryRepository() {
  const records = new Map();
  return {
    records,
    async create(record) {
      const key = `${record.provider}:${record.stateHash}`;
      if (records.has(key)) throw new Error('duplicate');
      records.set(key, { ...record });
    },
    async consume({ provider, stateHash, consumedAt }) {
      const key = `${provider}:${stateHash}`;
      const record = records.get(key);
      if (!record || record.expiresAt <= consumedAt) return null;
      records.delete(key);
      return { nonceHash: record.nonceHash };
    },
  };
}

function providerApplication(claimOverrides = {}) {
  return {
    async getAuthCodeUrl(request) {
      const url = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
      url.searchParams.set('client_id', CLIENT_ID);
      url.searchParams.set('state', request.state);
      url.searchParams.set('nonce', request.nonce);
      url.searchParams.set('code_challenge', request.codeChallenge);
      return url.toString();
    },
    async acquireTokenByCode() {
      return {
        idTokenClaims: {
          aud: CLIENT_ID,
          iss: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
          tid: TENANT_ID,
          oid: USER_ID,
          nonce: NONCE,
          exp: Math.floor(NOW_MS / 1000) + 3600,
          iat: Math.floor(NOW_MS / 1000) - 10,
          ver: '2.0',
          name: 'Pilot User',
          preferred_username: 'ignored@example.com',
          groups: ['ignored-group'],
          roles: ['ignored-role'],
          ...claimOverrides,
        },
      };
    },
  };
}

function entraClient(application = providerApplication()) {
  return createEntraClient({
    clientId: CLIENT_ID,
    clientSecret: 'test-client-secret-at-least-32-bytes-long',
    authority: AUTHORITY,
    redirectUri: REDIRECT_URI,
    clock: () => NOW_MS,
    application,
  });
}

function deterministicTokens() {
  const values = [STATE, NONCE];
  return () => values.shift();
}

function authService({ repository, client, resolver, sessionService } = {}) {
  return createEntraAuthService({
    repository: repository || memoryRepository(),
    entraClient: client || {
      async authorizationUrl() {
        return `${AUTHORITY}/organizations/oauth2/v2.0/authorize`;
      },
      async redeemAuthorizationCode() {
        return externalIdentity();
      },
    },
    identityResolver: resolver || {
      async resolve() { return { status: 'onboarding_required' }; },
    },
    sessionService: sessionService || {
      async issue() { throw new Error('not used'); },
    },
    transactionSecret: TRANSACTION_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    clock: () => NOW_MS,
    randomToken: deterministicTokens(),
  });
}

test('Entra adapter emits a trusted organizations authorization URL with PKCE inputs', async () => {
  const value = await entraClient().authorizationUrl({
    state: STATE,
    nonce: NONCE,
    codeChallenge: 'C'.repeat(43),
  });
  const parsed = new URL(value);
  assert.equal(parsed.origin, 'https://login.microsoftonline.com');
  assert.equal(parsed.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(parsed.searchParams.get('state'), STATE);
  assert.equal(parsed.searchParams.get('nonce'), NONCE);
});

test('Entra adapter rejects an authorization URL outside the fixed Microsoft authority', async () => {
  const application = providerApplication();
  application.getAuthCodeUrl = async () => 'https://attacker.example/oauth2/v2.0/authorize';
  await assert.rejects(
    entraClient(application).authorizationUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: 'C'.repeat(43),
    }),
    (error) => error instanceof EntraAuthenticationError,
  );
});

test('validated Entra claims are minimized and do not import provider roles, groups, or email authority', async () => {
  const identity = await entraClient().redeemAuthorizationCode({
    code: 'valid-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
  });
  assert.deepEqual(identity, {
    provider: ENTRA_IDENTITY_PROVIDER,
    tenantReference: TENANT_ID,
    userReference: USER_ID,
    displayName: 'Pilot User',
  });
});

test('optional Entra display names beyond the local profile bound never block a valid identity', async () => {
  const bounded = await entraClient(providerApplication({ name: 'N'.repeat(160) })).redeemAuthorizationCode({
    code: 'bounded-name-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
  });
  assert.equal(bounded.displayName, 'N'.repeat(160));

  for (const length of [161, 200]) {
    const identity = await entraClient(providerApplication({ name: 'N'.repeat(length) })).redeemAuthorizationCode({
      code: `long-name-${length}`,
      codeVerifier: 'V'.repeat(43),
      expectedNonceHash: hash(NONCE),
    });
    assert.equal(identity.tenantReference, TENANT_ID);
    assert.equal(identity.userReference, USER_ID);
    assert.equal(identity.displayName, null);
  }
});

test('two Entra organizations resolve to distinct provider-neutral tenant references', async () => {
  const first = await entraClient().redeemAuthorizationCode({
    code: 'first-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
  });
  const secondClient = entraClient(providerApplication({
    tid: OTHER_TENANT_ID,
    iss: `https://login.microsoftonline.com/${OTHER_TENANT_ID}/v2.0`,
  }));
  const second = await secondClient.redeemAuthorizationCode({
    code: 'second-code',
    codeVerifier: 'V'.repeat(43),
    expectedNonceHash: hash(NONCE),
  });
  assert.notEqual(first.tenantReference, second.tenantReference);
  assert.equal(first.userReference, second.userReference);
});

test('Entra claims fail closed for audience, issuer, nonce, expiry, tenant, and subject mismatches', async () => {
  const invalidCases = [
    { aud: '55555555-5555-4555-8555-555555555555' },
    { iss: 'https://login.microsoftonline.com/66666666-6666-4666-8666-666666666666/v2.0' },
    { nonce: 'wrong-nonce' },
    { exp: Math.floor(NOW_MS / 1000) },
    { tid: 'not-a-guid' },
    { oid: 'not-a-guid' },
  ];
  for (const overrides of invalidCases) {
    await assert.rejects(
      entraClient(providerApplication(overrides)).redeemAuthorizationCode({
        code: 'valid-code',
        codeVerifier: 'V'.repeat(43),
        expectedNonceHash: hash(NONCE),
      }),
      (error) => error instanceof EntraAuthenticationError,
    );
  }
});

test('provider token validation or signature failure is normalized to a safe authentication error', async () => {
  const application = providerApplication();
  application.acquireTokenByCode = async () => {
    throw new Error('provider included sensitive validation details');
  };
  await assert.rejects(
    entraClient(application).redeemAuthorizationCode({
      code: 'invalid-signature-code',
      codeVerifier: 'V'.repeat(43),
      expectedNonceHash: hash(NONCE),
    }),
    (error) => (
      error instanceof EntraAuthenticationError
      && error.code === 'ENTRA_CODE_REDEMPTION_FAILED'
    ),
  );
});

test('auth service stores hashed state/nonce, creates PKCE, and binds the initiating browser', async () => {
  const repository = memoryRepository();
  const captured = {};
  const service = authService({
    repository,
    client: {
      async authorizationUrl(input) {
        Object.assign(captured, input);
        return `${AUTHORITY}/oauth2/v2.0/authorize?state=${input.state}`;
      },
      async redeemAuthorizationCode() {
        throw new Error('not used');
      },
    },
  });

  const started = await service.start({ correlationId: 'corr-1' });
  assert.equal(captured.state, STATE);
  assert.equal(captured.nonce, NONCE);
  assert.match(captured.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  const transactionCookiePattern = new RegExp([
    '^cm_oidc_tx=[A-Za-z0-9_-]{43}',
    '; Path=/api/v1/auth/microsoft/callback',
    '; HttpOnly; SameSite=Lax; Secure; Max-Age=600$',
  ].join(''));
  assert.match(started.setCookie, transactionCookiePattern);
  assert.notEqual(cookieValue(started.setCookie), STATE);
  assert.equal(
    readEntraTransactionCookie({ cookie: started.setCookie }),
    cookieValue(started.setCookie),
  );
  const stored = [...repository.records.values()][0];
  assert.equal(stored.stateHash, hash(STATE));
  assert.equal(stored.nonceHash, hash(NONCE));
  assert.equal(JSON.stringify(stored).includes(STATE), false);
  assert.equal(JSON.stringify(stored).includes(NONCE), false);
  assert.equal(JSON.stringify(stored).includes(cookieValue(started.setCookie)), false);
  const clearCookiePattern = /^cm_oidc_tx=; .*Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/;
  assert.match(service.clearCookie(), clearCookiePattern);
});

test('callback requires initiating-browser binding before consuming globally stored state', async () => {
  const repository = memoryRepository();
  const service = authService({ repository });
  const started = await service.start();
  const correctBinding = cookieValue(started.setCookie);

  for (const browserBinding of [undefined, 'B'.repeat(43)]) {
    await assert.rejects(
      service.complete({ state: STATE, code: 'valid-code', browserBinding }),
      (error) => (
        error instanceof EntraAuthenticationError
        && error.code === 'OIDC_BROWSER_BINDING_INVALID'
      ),
    );
    assert.equal(repository.records.size, 1);
  }

  const completed = await service.complete({
    state: STATE,
    code: 'valid-code',
    browserBinding: correctBinding,
  });
  assert.deepEqual(completed, { status: 'onboarding_required' });
  assert.equal(repository.records.size, 0);
});

test('OIDC state is one-time, replay safe, and provider rejection consumes it', async () => {
  const repository = memoryRepository();
  let redeemed = 0;
  const service = authService({
    repository,
    client: {
      async authorizationUrl() {
        return `${AUTHORITY}/organizations/oauth2/v2.0/authorize`;
      },
      async redeemAuthorizationCode() {
        redeemed += 1;
        return externalIdentity();
      },
    },
  });

  const started = await service.start();
  const browserBinding = cookieValue(started.setCookie);
  const first = await service.complete({
    state: STATE,
    providerError: true,
    browserBinding,
  });
  assert.equal(first.status, 'authentication_rejected');
  assert.equal(redeemed, 0);
  await assert.rejects(
    service.complete({ state: STATE, code: 'replayed-code', browserBinding }),
    (error) => (
      error instanceof EntraAuthenticationError
      && error.code === 'OIDC_STATE_INVALID'
    ),
  );
});

test('transaction cookie parser rejects duplicates, malformed values, and oversized cookie input', () => {
  const valid = 'V'.repeat(43);
  assert.equal(
    readEntraTransactionCookie({
      cookie: `other=1; ${ENTRA_TRANSACTION_COOKIE_NAME}=${valid}`,
    }),
    valid,
  );
  const duplicateCookie = [
    `${ENTRA_TRANSACTION_COOKIE_NAME}=${valid}`,
    `${ENTRA_TRANSACTION_COOKIE_NAME}=${valid}`,
  ].join('; ');
  assert.equal(readEntraTransactionCookie({ cookie: duplicateCookie }), null);
  assert.equal(
    readEntraTransactionCookie({ cookie: `${ENTRA_TRANSACTION_COOKIE_NAME}=invalid` }),
    null,
  );
  assert.equal(readEntraTransactionCookie({ cookie: 'x'.repeat(8_193) }), null);
});

test('valid unresolved Entra identity routes to onboarding without issuing an application session', async () => {
  const repository = memoryRepository();
  let issued = false;
  const service = authService({
    repository,
    sessionService: { async issue() { issued = true; } },
  });

  const started = await service.start();
  const completed = await service.complete({
    state: STATE,
    code: 'valid-code',
    browserBinding: cookieValue(started.setCookie),
  });
  assert.deepEqual(completed, { status: 'onboarding_required' });
  assert.equal(issued, false);
});

test('resolved provider identity is handed to the existing server-side session service', async () => {
  const repository = memoryRepository();
  const trustedIdentity = {
    tenantId: '77777777-7777-4777-8777-777777777777',
    userId: '88888888-8888-4888-8888-888888888888',
    providerIdentity: {
      provider: ENTRA_IDENTITY_PROVIDER,
      reference: `${TENANT_ID}:${USER_ID}`,
    },
    roles: ['employee'],
    permissions: ['request:read'],
  };
  const service = authService({
    repository,
    resolver: {
      async resolve() { return { status: 'authenticated', trustedIdentity }; },
    },
    sessionService: {
      async issue(identity) {
        assert.equal(identity, trustedIdentity);
        return {
          principal: { userId: trustedIdentity.userId },
          setCookie: 'cm_session=opaque; HttpOnly',
        };
      },
    },
  });

  const started = await service.start();
  const completed = await service.complete({
    state: STATE,
    code: 'valid-code',
    browserBinding: cookieValue(started.setCookie),
    correlationId: 'corr-2',
  });
  assert.equal(completed.status, 'authenticated');
  assert.equal(completed.setCookie, 'cm_session=opaque; HttpOnly');
});
