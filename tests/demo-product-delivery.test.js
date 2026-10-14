import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { loadDemoProductDelivery } from '../src/demo/platform-product-delivery.js';
import { createDemoPlatformAccessGate } from '../src/demo/platform-access-gate.js';
import {
  handleDemoProductDelivery,
  DEMO_PRODUCT_DELIVERY_PATH,
} from '../src/demo/http/platform-product-delivery-handler.js';
import { createDemoPlatformHttpServer } from '../src/demo/platform-server.js';
import { createDemoPlatformRuntimeConfig } from '../src/demo/runtime-config.js';
import { compileProductDeliveryReport } from '../src/observability/product-delivery-report.js';
import { trafficFixture, listen, request } from './support/demo-traffic-gate-fixture.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
function credential() {
  const password = randomBytes(32).toString('base64url');
  return {
    authorization: `Basic ${Buffer.from(`ops:${password}`).toString('base64')}`,
    settings: {
      mode: 'password',
      passwordHash: createHash('sha256')
        .update('conference-manager:demo-platform-access:v1:')
        .update(password)
        .digest('hex'),
    },
  };
}

function snapshot() {
  return compileProductDeliveryReport({
    schemaVersion: 1,
    environment: 'demo',
    observedAt: new Date(NOW).toISOString(),
    periodStart: '2026-09-17T00:00:00.000Z',
    periodEnd: '2026-10-15T00:00:00.000Z',
    productComplete: true,
    productEvents: [],
    deliveryComplete: { application: false, api: false, website: false },
    deployments: [],
    feedbackSource: 'not_configured',
    feedbackComplete: false,
    feedback: [],
  });
}

test('private configuration and logical retention reject unsupported access, authority and malformed snapshots', () => {
  assert.equal(loadDemoProductDelivery({}, { mode: 'public' }), null);
  const settings = { mode: 'password' };
  const uncollected = loadDemoProductDelivery({}, settings).read(NOW);
  assert.equal(uncollected.collectionMode, 'not_collected');
  assert.equal(uncollected.freshness, 'unknown');
  assert.ok(uncollected.product.every((metric) => metric.value === null));
  for (const value of [
    [],
    '{',
    'x'.repeat(24_001),
    JSON.stringify({ ...snapshot(), ownerEmail: 'private@example.invalid' }),
  ]) {
    assert.throws(() =>
      loadDemoProductDelivery({ DEMO_PRODUCT_DELIVERY_SNAPSHOT: value }, settings),
    );
  }
  assert.throws(() =>
    loadDemoProductDelivery({ DEMO_PRODUCT_DELIVERY_TOKEN: 'unsupported' }, settings),
  );
  const env = { DEMO_PRODUCT_DELIVERY_SNAPSHOT: JSON.stringify(snapshot()) };
  assert.throws(() => loadDemoProductDelivery(env, { mode: 'public' }));
  const provider = loadDemoProductDelivery(env, settings);
  assert.equal(provider.read(NOW).freshness, 'fresh');
  assert.equal(provider.read(NOW + 86_400_000).freshness, 'stale');
  const expired = provider.read(NOW + 30 * 86_400_000);
  assert.equal(expired.observedAt, null);
  assert.ok(expired.product.every((metric) => metric.value === null));
  assert.throws(() => loadDemoProductDelivery(env, settings).read(NOW - 1));
});

test('actual Operations route enforces both gates, bounded GET and request-bound private access without database reads', async (t) => {
  const c = credential();
  const fixture = trafficFixture('platform', 'open');
  let closed = false;
  let reads = 0;
  const provider = loadDemoProductDelivery({}, c.settings);
  const server = createDemoPlatformHttpServer({
    config: createDemoPlatformRuntimeConfig(fixture.config),
    persistence: { pool: {} },
    demoRuntimeGatePool: {
      async connect() {
        throw new Error('UNEXPECTED_DATABASE_READ');
      },
    },
    accessGate: createDemoPlatformAccessGate({
      settings: c.settings,
      publicOrigin: fixture.config.origins.platform,
    }),
    trafficGate: {
      handle(req, res) {
        if (!closed) return false;
        res.statusCode = 503;
        res.end('closed');
        return true;
      },
    },
    productDelivery: {
      read() {
        reads += 1;
        return provider.read(NOW);
      },
    },
    routeModules: [],
    platformSessionService: {
      async resolvePrincipal() {
        throw new Error('UNEXPECTED_SESSION_READ');
      },
      async verifyCsrf() {
        throw new Error('UNEXPECTED_CSRF_READ');
      },
    },
    platformAuditService: {
      createDeniedEvent() {},
      createUnmappedAuthenticationFailure() {},
      async record() {},
    },
  });
  const port = await listen(t, server);
  for (const role of [
    'employee',
    'conference_manager',
    'tenant_admin',
    'platform_security_admin',
  ]) {
    assert.equal(
      (await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, { 'x-demo-role': role })).status,
      401,
    );
  }
  assert.equal(reads, 0);
  const headers = { authorization: c.authorization };
  const ok = await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, headers);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(ok.body).accessMode, 'shared_owner_password');
  assert.ok(!ok.body.includes(c.authorization));
  assert.equal(
    (await request(port, 'platform', `${DEMO_PRODUCT_DELIVERY_PATH}?tenant=foreign`, headers))
      .status,
    400,
  );
  assert.equal(
    (
      await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, {
        ...headers,
        'content-length': '1',
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, headers, 'POST')).status,
    405,
  );
  assert.equal(reads, 1);
  closed = true;
  assert.equal((await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, headers)).status, 503);
  assert.equal(reads, 1);
});

test('public Demo capability and forged request headers never expose projections; loader failures are minimized', async (t) => {
  const gate = createDemoPlatformAccessGate({
    settings: { mode: 'public', passwordHash: null },
    publicOrigin: 'https://platform.demo.invalid',
  });
  const port = await listen(
    t,
    http.createServer((req, res) => {
      gate.handle(req, res);
      handleDemoProductDelivery({
        request: req,
        response: res,
        accessGate: gate,
        productDelivery: {
          read() {
            throw new Error('SECRET_SOURCE_MUST_NOT_BE_READ');
          },
        },
      });
    }),
  );
  assert.equal(
    (
      await request(port, 'platform', DEMO_PRODUCT_DELIVERY_PATH, {
        'x-demo-role': 'platform_security_admin',
      })
    ).status,
    404,
  );
  const privateGate = {
    hasPrivateReadAccess() {
      return true;
    },
  };
  const failing = await listen(
    t,
    http.createServer((req, res) =>
      handleDemoProductDelivery({
        request: req,
        response: res,
        accessGate: privateGate,
        productDelivery: {
          read() {
            throw new Error('SECRET_SOURCE_MUST_NOT_LEAK');
          },
        },
      }),
    ),
  );
  const response = await request(failing, 'platform', DEMO_PRODUCT_DELIVERY_PATH);
  assert.equal(response.status, 503);
  assert.equal(JSON.parse(response.body).error.code, 'PLATFORM_PRODUCT_DELIVERY_UNAVAILABLE');
  assert.ok(!response.body.includes('SECRET_SOURCE'));
});
