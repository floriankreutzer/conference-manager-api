import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringOrderRouteModules } from '../src/catering-order-composition.js';
import { loadConfig } from '../src/config.js';
import { cateringConfigurationEnabled, cateringOrdersEnabled, loadFeatureFlags } from '../src/feature-flags.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createHttpServer } from '../src/server.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORIGIN = 'http://localhost:3000';
const ROOT = '/api/v1/tenant/catering/orders';
const logger = { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} };
function request(port, { method = 'GET', path = ROOT, cookie, csrf, body, origin = ORIGIN } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, method, path, headers: {
      Host: new URL(ORIGIN).host, Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
    outgoing.on('error', reject); outgoing.end(body);
  });
}

test('separate server order rollout defaults off, is strict, and preserves the existing configuration resolver contract', () => {
  assert.equal(cateringOrdersEnabled(), false);
  assert.equal(cateringOrdersEnabled({ 'catering.configuration': true }), false);
  const flags = loadFeatureFlags({ CATERING_ORDERS_ENABLED: 'true' });
  assert.equal(cateringOrdersEnabled(flags), true);
  assert.equal(cateringConfigurationEnabled(flags), false);
  assert.equal(Object.isFrozen(flags), true);
  for (const value of ['', true, false, 1, null, 'TRUE', '1', ' true ']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', CATERING_ORDERS_ENABLED: value }), /CATERING_ORDERS_ENABLED_INVALID/);
  }
  for (const value of [{ 'catering.orders': true }, { 'catering.configuration': false, unknown: true },
    { 'catering.configuration': false, 'catering.orders': 'true' }]) {
      assert.throws(() => cateringOrdersEnabled(value), /FEATURE_FLAGS_INVALID/);
    }
  let reads = 0;
  const accessor = Object.defineProperty({ 'catering.configuration': false }, 'catering.orders', {
    enumerable: true, get() { reads++; return true; },
  });
  assert.throws(() => cateringOrdersEnabled(accessor), /FEATURE_FLAGS_INVALID/); assert.equal(reads, 0);
});

test('disabled order composition touches no persistence, and enabled composition refuses Demo or missing dependencies', () => {
  const persistence = new Proxy({}, { get() { throw new Error('PERSISTENCE_ACCESSED'); } });
  assert.deepEqual(createCateringOrderRouteModules({ config: {}, persistence }), []);
  const featureFlags = { 'catering.configuration': false, 'catering.orders': true };
  assert.throws(() => createCateringOrderRouteModules({ config: { featureFlags } }), /PERSISTENCE_REQUIRED/);
  assert.throws(() => createCateringOrderRouteModules({ config: { featureFlags, demoRuntime: true } }), /DEMO_NOT_SUPPORTED/);
});

test('real opaque session and CSRF guards precede scoped order reads and schema validation', async (t) => {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const sessions = new Map();
  const state = { reads: [], mutations: 0, revoked: false };
  const sessionService = createSessionService({ publicOrigin: ORIGIN, csrfSecret: 'synthetic-catering-orders-csrf-key-32-bytes',
    auditService: audit.service, repository: {
      async issue(record) { const stored = { ...record, securityVersion: 1 }; sessions.set(record.tokenHash, stored); return stored; },
      async resolveByTokenHash(hash, now) {
        const stored = sessions.get(hash);
        return !state.revoked && stored && Date.parse(stored.expiresAt) > now.getTime() ? stored : null;
      },
    } });
  async function issue(tenantId, roles, permissions) {
    const value = await sessionService.issue({ tenantId, userId: id(4), securityVersion: 1,
      providerIdentity: { provider: 'test_oidc', reference: 'synthetic-subject' }, roles, permissions }, { correlationId: id(9) });
    return { cookie: value.setCookie.split(';', 1)[0], csrf: value.csrfToken };
  }
  const manager = await issue(id(1), ['conference_manager'], ['request:manage']);
  const otherSession = await issue(id(1), ['conference_manager'], ['request:manage']);
  const foreign = await issue(id(2), ['conference_manager'], ['request:manage']);
  const admin = await issue(id(1), ['tenant_admin'], ['tenant:integrations:manage']);
  const employee = await issue(id(1), ['employee'], ['request:read']);
  const pool = {
    async query(query) {
      assert.equal(query.name, 'catering-order-list-bounded'); state.reads.push(query.values);
      return { rows: [], rowCount: 0 };
    },
    async connect() { state.mutations++; throw new Error('UNEXPECTED_TRANSACTION'); },
  };
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN, CATERING_ORDERS_ENABLED: 'true' });
  const modules = createCateringOrderRouteModules({ config, authorizationPolicy, auditService: audit.service,
    persistence: { pool, auditRepository: { async appendWithClient() { throw new Error('UNEXPECTED_ORDER_AUDIT'); } } } });
  const server = createHttpServer({ config, additionalRouteModules: modules, authorizationPolicy, auditService: audit.service,
    sessionService, logger, loadTenant: async (tenantId) => ({ id: tenantId, displayName: 'Synthetic Tenant', status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, admin)).status, 403);
  assert.equal((await request(port, employee)).status, 403);
  const own = await request(port, manager); assert.equal(own.status, 200); assert.deepEqual(own.body.orders, []);
  const other = await request(port, foreign); assert.equal(other.status, 200); assert.deepEqual(other.body.orders, []);
  assert.deepEqual(state.reads, [[id(1),null,null],[id(2),null,null]]);
  const prepare = JSON.stringify({ schemaVersion: 1, requestId: 'request-a', commandId: id(5),
    expectedRequestVersion: 2, expectedAssignmentRevision: 3 });
  for (const overrides of [{ csrf: undefined }, { csrf: 'x'.repeat(43) }, { csrf: otherSession.csrf },
    { csrf: foreign.csrf }, { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(port, { ...manager, method: 'POST', body: prepare, ...overrides })).status, 403);
    assert.equal((await request(port, { ...manager, method: 'PUT', path: `${ROOT}/${id(6)}/quote`,
      body: '{}', ...overrides })).status, 403);
    assert.equal((await request(port, { ...manager, method: 'POST', path: `${ROOT}/${id(6)}/decision`,
      body: '{}', ...overrides })).status, 403);
  }
  assert.equal((await request(port, { ...manager, method: 'POST', body: '{"tenantId":"untrusted"}' })).status, 400);
  assert.equal((await request(port, { ...manager, method: 'PUT', path: `${ROOT}/${id(6)}/quote`, body: '{}' })).status, 400);
  assert.equal((await request(port, { ...manager, method: 'POST', path: `${ROOT}/${id(6)}/decision`, body: '{}' })).status, 400);
  assert.equal((await request(port, { ...admin, method: 'POST', body: prepare })).status, 403);
  assert.equal(state.mutations, 0);
  state.revoked = true;
  assert.equal((await request(port, manager)).status, 401);
});

test('default-off HTTP publishes none of the new order paths', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN });
  const server = createHttpServer({ config, additionalRouteModules: createCateringOrderRouteModules({ config }), logger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  for (const path of [ROOT, `${ROOT}/${id(6)}`, `${ROOT}/${id(6)}/quote`, `${ROOT}/${id(6)}/decision`]) {
    assert.equal((await request(server.address().port, { path })).status, 404);
  }
});
