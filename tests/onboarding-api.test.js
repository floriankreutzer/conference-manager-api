import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/server.js';

const INVITATION_TOKEN = 'I'.repeat(43);
const INVITATION_ID = '11111111-1111-4111-8111-111111111111';
const CLAIM_TOKEN = 'C'.repeat(43);
const CSRF_TOKEN = 'S'.repeat(43);
const OIDC_COOKIE = 'cm_oidc_tx=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CLAIM_COOKIE = `cm_tenant_claim=${CLAIM_TOKEN}`;

function request({ port, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: `localhost:${port}`,
        Origin: `http://localhost:${port}`,
        ...(payload === null ? {} : {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null,
        });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function withServer({ onboardingService, entraAuthService }, run) {
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }) };
  const server = createHttpServer({ config, onboardingService, entraAuthService });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_INVALID');
    config.publicOrigin = `http://localhost:${address.port}`;
    await run(address.port);
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

function onboardingService(overrides = {}) {
  return {
    async beginInvitation() { return { invitationId: INVITATION_ID }; },
    async claimStatus() {
      return {
        tenant: { displayName: 'Contoso' },
        expiresAt: '2026-08-24T12:10:00.000Z',
        csrfToken: CSRF_TOKEN,
      };
    },
    async confirmClaim() { return { status: 'claimed', tenantStatus: 'onboarding' }; },
    clearClaimCookie() {
      return 'cm_tenant_claim=; Path=/api/v1/onboarding/claim; HttpOnly; SameSite=Strict; Max-Age=0';
    },
    ...overrides,
  };
}

test('onboarding start accepts only invitation token and persists trusted invitation context in OIDC start', async () => {
  let invitationInput;
  let oidcInput;
  await withServer({
    onboardingService: onboardingService({
      async beginInvitation(value) {
        invitationInput = value;
        return { invitationId: INVITATION_ID };
      },
    }),
    entraAuthService: {
      async start(value) {
        oidcInput = value;
        return {
          authorizationUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
          setCookie: `${OIDC_COOKIE}; Path=/api/v1/auth/microsoft/callback; HttpOnly; SameSite=Lax`,
        };
      },
    },
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/onboarding/invitations/start',
      method: 'POST',
      body: { invitationToken: INVITATION_TOKEN },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.authorizationUrl.includes('login.microsoftonline.com'), true);
    assert.deepEqual(invitationInput, { invitationToken: INVITATION_TOKEN });
    assert.equal(oidcInput.onboardingInvitationId, INVITATION_ID);
    assert.match(oidcInput.correlationId, /^[0-9a-f-]{36}$/i);
    assert.match(response.headers['set-cookie'][0], /^cm_oidc_tx=/);
  });
});

test('onboarding start rejects browser tenant authority and unknown fields before services run', async () => {
  let calls = 0;
  await withServer({
    onboardingService: onboardingService({
      async beginInvitation() {
        calls += 1;
        return { invitationId: INVITATION_ID };
      },
    }),
    entraAuthService: {
      async start() {
        calls += 1;
        throw new Error('must not run');
      },
    },
  }, async (port) => {
    for (const body of [
      { invitationToken: INVITATION_TOKEN, tenantId: INVITATION_ID },
      { invitationToken: INVITATION_TOKEN, tid: INVITATION_ID },
      { invitationToken: INVITATION_TOKEN, unexpected: true },
    ]) {
      const response = await request({
        port,
        path: '/api/v1/onboarding/invitations/start',
        method: 'POST',
        body,
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(calls, 0);
  });
});

test('Entra callback enters fixed claim-confirmation route without issuing a session cookie', async () => {
  await withServer({
    onboardingService: onboardingService(),
    entraAuthService: {
      async complete() {
        return {
          status: 'claim_confirmation_required',
          setCookie: `${CLAIM_COOKIE}; Path=/api/v1/onboarding/claim; HttpOnly; SameSite=Strict`,
        };
      },
      clearCookie() {
        return 'cm_oidc_tx=; Path=/api/v1/auth/microsoft/callback; HttpOnly; SameSite=Lax; Max-Age=0';
      },
    },
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/auth/microsoft/callback?code=valid-code&state=valid-state',
      headers: { Cookie: OIDC_COOKIE },
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/onboarding?auth=confirm');
    assert.equal(response.headers['set-cookie'].length, 2);
    assert.match(response.headers['set-cookie'][0], /^cm_oidc_tx=;/);
    assert.match(response.headers['set-cookie'][1], /^cm_tenant_claim=/);
    assert.equal(response.headers['set-cookie'].join(';').includes('cm_session='), false);
  });
});

test('claim status exposes only safe tenant presentation and server-derived CSRF', async () => {
  let token;
  await withServer({
    onboardingService: onboardingService({
      async claimStatus(value) {
        token = value.claimToken;
        return {
          tenant: { displayName: 'Contoso' },
          expiresAt: '2026-08-24T12:10:00.000Z',
          csrfToken: CSRF_TOKEN,
        };
      },
    }),
    entraAuthService: null,
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/onboarding/claim',
      headers: { Cookie: CLAIM_COOKIE },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(token, CLAIM_TOKEN);
    assert.deepEqual(response.body.tenant, { displayName: 'Contoso' });
    assert.equal(response.body.csrfToken, CSRF_TOKEN);
    assert.equal(Object.hasOwn(response.body.tenant, 'id'), false);
    assert.equal(JSON.stringify(response.body).includes('tenantReference'), false);
  });
});

test('claim confirmation requires exact confirmation body and forwards cookie plus CSRF only', async () => {
  let confirmed;
  await withServer({
    onboardingService: onboardingService({
      async confirmClaim(value) {
        confirmed = value;
        return { status: 'claimed', tenantStatus: 'onboarding' };
      },
    }),
    entraAuthService: null,
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/onboarding/claim',
      method: 'POST',
      headers: { Cookie: CLAIM_COOKIE, 'X-CSRF-Token': CSRF_TOKEN },
      body: { confirm: true },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.status, 'claimed');
    assert.deepEqual(response.body.tenant, { status: 'onboarding' });
    assert.equal(confirmed.claimToken, CLAIM_TOKEN);
    assert.equal(confirmed.csrfToken, CSRF_TOKEN);
    assert.equal(Object.hasOwn(confirmed, 'tenantId'), false);
    assert.match(response.headers['set-cookie'][0], /^cm_tenant_claim=;/);

    const manipulated = await request({
      port,
      path: '/api/v1/onboarding/claim',
      method: 'POST',
      headers: { Cookie: CLAIM_COOKIE, 'X-CSRF-Token': CSRF_TOKEN },
      body: { confirm: true, tenantId: INVITATION_ID },
    });
    assert.equal(manipulated.statusCode, 400);
    assert.equal(manipulated.body.error.code, 'VALIDATION_FAILED');
  });
});
