import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { loadProtectedPlatformInsightSnapshots } from '../src/observability/platform-insight-snapshots.js';
import { createPlatformInsightService } from '../src/platform/application/insight-service.js';
import { createPlatformInsightRoutes } from '../src/platform/http/insight-routes.js';
import { createPlatformAuthorizationPolicy, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
function principal(mode = 'all', roles = ['platform_support_reader', 'platform_security_admin']) {
  return { operatorId: '11111111-1111-4111-8111-111111111111', roles,
    permissions: permissionsForPlatformRoles(roles), securityVersion: 1,
    providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: 'tenant', subjectReference: 'subject' },
    targetScope: { mode, securityVersion: 1 },
    assurance: { level: 'mfa', authenticationContext: 'cm:pk:v1', authenticatedAt: new Date(NOW).toISOString() },
    session: { id: '22222222-2222-4222-8222-222222222222', securityVersion: 1, securityEpoch: 2,
      issuedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3600000).toISOString(), stepUpExpiresAt: null } };
}
function snapshot() {
  return { schemaVersion: 1, plan: 'launch_v3', referenceObservedAt: '2026-10-01T00:00:00.000Z',
    finops: { schemaVersion: 1, current: { schemaVersion: 1,
      periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
      observedAt: '2026-10-22T00:00:00.000Z',
      measurements: [{ source: 'database_transfer', unit: 'bytes', used: 1000, limit: 500000000000 }] },
    history: [], rates: [] } };
}
function service(sources = loadProtectedPlatformInsightSnapshots()) {
  return createPlatformInsightService({ sources, authorizationPolicy: createPlatformAuthorizationPolicy(), clock: () => NOW });
}

test('protected reports retain unknowns, strict source identity and expiry without Demo authority', () => {
  const sources = loadProtectedPlatformInsightSnapshots();
  assert.equal(sources.readProvider(NOW), null);
  const product = sources.readProduct(NOW);
  assert.equal(product.environment, 'production');
  assert.equal(product.accessMode, 'application_passkey');
  assert.equal(product.collectionMode, 'not_collected');
  assert.ok(product.product.every(row => row.value === null));
  assert.equal(product.feedback.total, null);
  for (const raw of ['{', ' '.repeat(24001), JSON.stringify({ ...snapshot(), password: 'forbidden' })]) {
    assert.throws(() => loadProtectedPlatformInsightSnapshots({ providerSnapshot: raw }));
  }
  assert.throws(() => loadProtectedPlatformInsightSnapshots({ productSnapshot: JSON.stringify(product) }));
  const provider = loadProtectedPlatformInsightSnapshots({ providerSnapshot: JSON.stringify(snapshot()) }).readProvider(NOW);
  assert.equal(provider.neon.usedBytes, 1000);
  assert.equal(provider.accessMode, 'application_passkey');
  assert.equal(provider.freshness, 'stale');
  assert.equal(provider.costState, 'unknown');
  assert.throws(() => sources.readProduct(-1));
});

test('global insight service denies Customer, missing MFA/permission and allowlisted operators before source access', () => {
  let reads = 0;
  const values = service({ readProvider() { reads++; return {}; }, readProduct() { reads++; return {}; } });
  for (const operatorContext of [{ roles: ['tenant_admin'] }, principal('allowlist'),
    { ...principal(), permissions: [] }, { ...principal(), assurance: { ...principal().assurance, level: 'password' } }]) {
    assert.throws(() => values.read({ operatorContext, kind: 'providers' }));
  }
  assert.equal(reads, 0);
  assert.throws(() => values.read({ operatorContext: principal('all', ['platform_support_reader']), kind: 'providers' }));
  assert.equal(reads, 0);
  values.read({ operatorContext: principal(), kind: 'providers' });
  assert.equal(reads, 1);
  assert.throws(() => values.read({ operatorContext: principal(), kind: 'other' }));
});

test('protected insight routes authenticate fixed GETs and reject unsupported methods, query and unavailable provider', async () => {
  const module = createPlatformInsightRoutes(service());
  let authenticated = 0;
  const handler = module.createHandler({ maxResponseBytes: 100000, platformPrincipalGuard: {
    async require() { authenticated++; return principal(); },
  } });
  async function invoke(path, method = 'GET', body = '', query = '') {
    const request = Readable.from(body ? [Buffer.from(body)] : []); request.method = method;
    request.headers = body ? { 'content-length': String(Buffer.byteLength(body)) } : {};
    let payload;
    const response = { setHeader() {}, end(value) { payload = JSON.parse(value); } };
    const status = await handler({ path, parsedUrl: new URL(path + query, 'https://ops.example.test'),
      request, response, requestId: '33333333-3333-4333-8333-333333333333' });
    return { status, payload };
  }
  const path = '/api/v1/platform/insights/product-delivery';
  assert.equal((await invoke(path)).payload.accessMode, 'application_passkey');
  assert.equal(authenticated, 1);
  await assert.rejects(invoke(path, 'POST'), error => error.statusCode === 405);
  await assert.rejects(invoke(path, 'GET', '', '?tenantId=foreign'), error => error.statusCode === 400);
  await assert.rejects(invoke(path, 'GET', '{}'), error => error.statusCode === 400);
  await assert.rejects(invoke('/api/v1/platform/insights/providers'), error => error.statusCode === 503);
  const denied = module.createHandler({ maxResponseBytes: 100000, platformPrincipalGuard: {
    async require() { throw new Error('unauthenticated'); },
  } });
  await assert.rejects(denied({ path, request: { method: 'GET' }, parsedUrl: new URL(path, 'https://ops.example.test') }));
  assert.equal(module.claim({ path: '/api/v1/platform/demo/product-delivery' }), null);
});
