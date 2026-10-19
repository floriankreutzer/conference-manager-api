import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createCateringConfigurationRouteModules } from '../src/catering-configuration-composition.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { loadConfig } from '../src/config.js';
import { cateringConfigurationEnabled, loadFeatureFlags } from '../src/feature-flags.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createHttpServer } from '../src/server.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (number) => `d0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ORIGIN = 'http://localhost:3000';
const PATH = `/api/v1/integrations/catering/${id(3)}/configuration`;

test('server feature configuration defaults off and admits only exact boolean rollout values', () => {
  assert.equal(cateringConfigurationEnabled(), false);
  assert.deepEqual(loadConfig({ NODE_ENV: 'test' }).featureFlags, {
    'catering.configuration': false, 'catering.orders': false, 'catering.delivery': false,
  });
  for (const value of ['true', 'false']) {
    const flags = loadFeatureFlags({ CATERING_CONFIGURATION_ENABLED: value });
    assert.equal(cateringConfigurationEnabled(flags), value === 'true');
    assert.ok(Object.isFrozen(flags));
  }
  for (const value of ['', true, false, 1, null, 'TRUE', '1', ' false ']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', CATERING_CONFIGURATION_ENABLED: value }),
      /CATERING_CONFIGURATION_ENABLED_INVALID/);
  }
  for (const flags of [null, {}, [], { 'catering.configuration': 'true' },
    { 'catering.configuration': true, unknown: true },
    Object.defineProperty({}, 'catering.configuration', { enumerable: true, get() { throw new Error('GETTER_CALLED'); } })]) {
    assert.throws(() => cateringConfigurationEnabled(flags), /FEATURE_FLAGS_INVALID/);
  }
});

test('disabled composition constructs no persistence and enabled composition fails closed without real dependencies', () => {
  const persistence = new Proxy({}, { get() { throw new Error('PERSISTENCE_ACCESSED'); } });
  assert.deepEqual(createCateringConfigurationRouteModules({ config: {}, persistence }), []);
  const config = { featureFlags: { 'catering.configuration': true } };
  assert.throws(() => createCateringConfigurationRouteModules({ config }), /PERSISTENCE_REQUIRED/);
  assert.throws(() => createCateringConfigurationRouteModules({ config: { ...config, demoRuntime: true } }),
    /DEMO_NOT_SUPPORTED/);
  const registry = createCateringConfigurationRegistry();
  assert.deepEqual(registry.list().map((entry) => entry.id), ['manual_catering']);
  assert.equal(registry.requireMode('manual_catering', 'catering.order', 'manual').runtime, 'production');
  assert.throws(() => registry.requireMode('manual_catering', 'catering.order', 'api'), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => registry.get('demo_caterer'), /PROVIDER_UNKNOWN/);
});

function request(port, { method = 'GET', cookie, csrf, origin = ORIGIN, path = PATH, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ hostname: '127.0.0.1', port, path, method, headers: {
      Host: new URL(ORIGIN).host, Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('TEST_HTTP_TIMEOUT')));
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('composed HTTP uses actual opaque session/CSRF guards and Tenant-scoped PostgreSQL adapter reads', async (t) => {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const sessions = new Map();
  const state = { revoked: false, reads: [], connections: 0 };
  const sessionService = createSessionService({
    auditService: audit.service, publicOrigin: ORIGIN, csrfSecret: 'synthetic-test-only-csrf-secret-minimum-32-bytes',
    repository: {
      async issue(record) {
        const stored = { ...record, securityVersion: 1 };
        sessions.set(record.tokenHash, stored);
        return stored;
      },
      async resolveByTokenHash(hash, now) {
        const stored = sessions.get(hash);
        return !state.revoked && stored && Date.parse(stored.expiresAt) > now.getTime() ? stored : null;
      },
    },
  });
  const issue = async (tenantId, roles, permissions) => {
    const issued = await sessionService.issue({ tenantId, userId: id(4), securityVersion: 1,
      providerIdentity: { provider: 'test_oidc', reference: 'synthetic-subject' }, roles, permissions },
    { correlationId: id(9) });
    return { cookie: issued.setCookie.split(';', 1)[0], csrf: issued.csrfToken };
  };
  const admin = await issue(id(1), ['tenant_admin'], ['tenant:integrations:manage']);
  const foreign = await issue(id(2), ['tenant_admin'], ['tenant:integrations:manage']);
  const manager = await issue(id(1), ['conference_manager'], ['request:manage']);
  const pool = {
    async query(query) {
      state.reads.push(query.values);
      assert.ok(['catering-configuration-read', 'catering-configuration-list'].includes(query.name));
      return { rows: query.values[0] === id(1) && (query.name === 'catering-configuration-list' || query.values[1] === id(3)) ? [{
        tenant_id: id(1), integration_id: id(3), provider: 'manual_catering', revision: 1,
        initial_order_mode: 'manager_review', catalogue_mode: 'manual', availability_mode: 'manual',
        order_mode: 'manual', update_mode: 'manual', cancel_mode: 'manual', status_mode: 'manual',
      }] : [] };
    },
    async connect() { state.connections += 1; throw new Error('UNEXPECTED_WRITE'); },
  };
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN, CATERING_CONFIGURATION_ENABLED: 'true' });
  const modules = createCateringConfigurationRouteModules({ config, authorizationPolicy, auditService: audit.service,
    persistence: { pool, auditRepository: { appendWithClient: async () => true } } });
  const server = createHttpServer({ config, authorizationPolicy, auditService: audit.service, sessionService,
    additionalRouteModules: modules, loadTenant: async (tenantId) => ({ id: tenantId, displayName: 'Synthetic Tenant',
      status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }),
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  assert.equal((await request(port)).status, 401);
  const result = await request(port, admin);
  assert.equal(result.status, 200);
  assert.equal(result.body.providerId, 'manual_catering');
  assert.deepEqual(state.reads, [[id(1), id(3)]]);
  assert.equal((await request(port, foreign)).status, 404);
  assert.equal((await request(port, manager)).status, 403);
  assert.equal(state.reads.length, 2);
  const collection = '/api/v1/integrations/catering';
  const listed = await request(port, { ...admin, path: collection });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.connections[0].integrationId, id(3));
  assert.deepEqual(state.reads.at(-1), [id(1), null]);
  const empty = await request(port, { ...foreign, path: collection });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.connections, []);
  assert.equal((await request(port, { ...manager, path: collection })).status, 403);
  const body = JSON.stringify({ schemaVersion: 1, expectedRevision: 1,
    configuration: { initialOrderMode: 'manager_review', capabilities: { 'catering.order': 'manual' } } });
  for (const overrides of [{ csrf: undefined }, { csrf: 'x'.repeat(43) }, { csrf: foreign.csrf }, { origin: 'https://foreign.invalid' }]) {
    assert.equal((await request(port, { ...admin, method: 'PUT', body, ...overrides })).status, 403);
    assert.equal((await request(port, { ...admin, path: collection, method: 'POST', body: '{}', ...overrides })).status, 403);
  }
  // A genuine session-bound token reaches positive-schema validation, without a persistence mutation.
  const invalid = await request(port, { ...admin, method: 'PUT', body: '{"tenantId":"untrusted"}' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
  const invalidCreate = await request(port, { ...admin, path: collection, method: 'POST', body: '{}' });
  assert.equal(invalidCreate.status, 400);
  assert.equal(invalidCreate.body.error.code, 'VALIDATION_FAILED');
  assert.equal(state.connections, 0);
  state.revoked = true;
  assert.equal((await request(port, admin)).status, 401);
});

test('default-off Customer HTTP does not expose the configuration route', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: ORIGIN });
  const modules = createCateringConfigurationRouteModules({ config });
  const server = createHttpServer({ config, additionalRouteModules: modules,
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  assert.equal((await request(server.address().port)).status, 404);
  assert.equal((await request(server.address().port, { path: '/api/v1/integrations/catering' })).status, 404);
  assert.equal((await request(server.address().port, { path: PATH.replace('/configuration','/health') })).status, 404);
  for (const path of ['/api/v1/tenant/catering/catalogue-assignments', '/api/v1/tenant/catering/catalogue-connections']) {
    assert.equal((await request(server.address().port, { path })).status, 404);
  }
});
