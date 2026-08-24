import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { EntraAuthenticationError } from '../src/identity/entra-errors.js';
import { createHttpServer } from '../src/server.js';

function request({ port, path, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Host: `localhost:${port}`,
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
    req.end();
  });
}

async function withServer(entraAuthService, run) {
  const config = {
    ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000' }),
  };
  const server = createHttpServer({ config, entraAuthService });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  config.publicOrigin = `http://localhost:${port}`;
  try {
    await run(port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('Microsoft login route redirects only to the provider-generated authorization URL', async () => {
  const authorizationUrl = 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=test';
  await withServer({
    async start() { return { authorizationUrl }; },
  }, async (port) => {
    const response = await request({ port, path: '/api/v1/auth/microsoft/login' });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, authorizationUrl);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body, null);
  });
});

test('Microsoft login route rejects browser-selected tenant or other query input', async () => {
  await withServer({
    async start() { throw new Error('must not be called'); },
  }, async (port) => {
    const response = await request({ port, path: '/api/v1/auth/microsoft/login?tenantId=attacker' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  });
});

test('successful Entra callback sets only the server session cookie and redirects to a fixed local path', async () => {
  let callback;
  await withServer({
    async complete(value) {
      callback = value;
      return { status: 'authenticated', setCookie: 'cm_session=opaque; Path=/api; HttpOnly; SameSite=Lax' };
    },
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/auth/microsoft/callback?code=valid-code&state=valid-state',
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/');
    assert.match(response.headers['set-cookie'][0], /^cm_session=opaque;/);
    assert.equal(callback.code, 'valid-code');
    assert.equal(callback.state, 'valid-state');
    assert.equal(callback.providerError, false);
    assert.match(callback.correlationId, /^[0-9a-f-]{36}$/i);
  });
});

test('valid but unresolved Entra identity routes to tenant onboarding without a session cookie', async () => {
  await withServer({
    async complete() { return { status: 'onboarding_required' }; },
  }, async (port) => {
    const response = await request({
      port,
      path: '/api/v1/auth/microsoft/callback?code=valid-code&state=valid-state',
    });
    assert.equal(response.statusCode, 303);
    assert.equal(response.headers.location, '/?auth=tenant_onboarding_required');
    assert.equal(response.headers['set-cookie'], undefined);
  });
});

test('provider rejection and invalid state use fixed safe failure redirects without provider details', async () => {
  await withServer({
    async complete({ providerError }) {
      if (providerError) return { status: 'authentication_rejected' };
      throw new EntraAuthenticationError('OIDC_STATE_INVALID');
    },
  }, async (port) => {
    const providerRejected = await request({
      port,
      path: '/api/v1/auth/microsoft/callback?error=access_denied&error_description=sensitive-details&state=valid-state',
    });
    assert.equal(providerRejected.statusCode, 303);
    assert.equal(providerRejected.headers.location, '/?auth=authentication_failed');
    assert.equal(providerRejected.headers.location.includes('sensitive-details'), false);

    const invalidState = await request({
      port,
      path: '/api/v1/auth/microsoft/callback?code=valid-code&state=invalid-state',
    });
    assert.equal(invalidState.statusCode, 303);
    assert.equal(invalidState.headers.location, '/?auth=authentication_failed');
  });
});

test('callback rejects unknown, duplicate, and browser-controlled tenant parameters before auth completion', async () => {
  let calls = 0;
  await withServer({
    async complete() {
      calls += 1;
      return { status: 'onboarding_required' };
    },
  }, async (port) => {
    for (const path of [
      '/api/v1/auth/microsoft/callback?code=x&state=y&tenantId=attacker',
      '/api/v1/auth/microsoft/callback?code=x&state=y&state=z',
      '/api/v1/auth/microsoft/callback?code=x&state=y&unexpected=value',
    ]) {
      const response = await request({ port, path });
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, 'VALIDATION_FAILED');
    }
    assert.equal(calls, 0);
  });
});
