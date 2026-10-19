import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCateringConfigurationService } from '../src/application/catering-configuration-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringConfigurationHttpHandler } from '../src/http/settings/catering-integrations.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { normalizeCateringConfiguration } from '../src/integrations/catering-configuration.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (n) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1);
const configuration = () => ({ initialOrderMode: 'manager_review', capabilities: { 'catering.order': 'manual' } });
const actor = () => ({ tenantId, userId: id(2), roles: ['tenant_admin'], permissions: ['tenant:integrations:manage'],
  session: { id: id(3), securityVersion: 1 } });
const context = () => ({ principal: actor(), tenantContext: { tenantId, status: 'active' }, correlationId: id(4) });
const command = () => ({ ...context(), schemaVersion: 1, commandId: id(5), providerId: 'manual_catering', configuration: configuration() });

function fixture() {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const registry = createCateringConfigurationRegistry();
  const calls = [];
  let row = null;
  let nextId = 10;
  const repository = {
    loadCurrent: async () => row,
    update: async () => { throw new Error('UNEXPECTED_UPDATE'); },
    async create(input) {
      calls.push(input);
      if (row) return { status: 'updated', replayed: true, current: row };
      const event = input.auditEventFor({ revision: 1 });
      assert.equal(event.tenantId, tenantId);
      assert.equal(event.targetId, input.integrationId);
      assert.equal(event.actorUserId, id(2));
      assert.deepEqual(event.metadata, { operation: 'catering_configuration_create' });
      row = { tenantId, integrationId: input.integrationId, providerId: input.providerId, revision: 1,
        configuration: input.configuration };
      return { status: 'updated', current: row };
    },
    async listCurrent(input) { calls.push(input); return { items: row ? [row] : [], nextAfterIntegrationId: null }; },
  };
  const make = (overrides = {}) => createCateringConfigurationService({ repository, registry, authorizationPolicy,
    auditService: audit.service, idFactory: () => id(nextId++), ...overrides });
  return { service: make(), make, repository, calls, registry };
}

test('setup generates object authority server-side and returns an original replay receipt without a duplicate audit', async () => {
  const f = fixture();
  const first = await f.service.create(command());
  assert.equal(first.integrationId, id(10));
  assert.equal(first.revision, 1);
  assert.equal(f.calls[0].expectedRevision, 0);
  assert.equal(f.calls[0].commandId, id(5));
  assert.equal(f.calls[0].sessionId, id(3));
  assert.equal(f.calls[0].expectedSecurityVersion, 1);
  assert.equal(f.calls[0].configuration.capabilities['catering.catalogue'], 'unsupported');
  assert.deepEqual(await f.service.create(command()), first);
  const page = await f.service.list(context());
  assert.deepEqual(page.connections, [first]);
  assert.deepEqual(page.providers.map((entry) => entry.providerId), ['manual_catering']);
  assert.equal(page.nextAfterIntegrationId, null);
  assert.ok(Object.isFrozen(page.connections));
  assert.deepEqual(f.calls.at(-1), { tenantId, afterIntegrationId: null });
});

test('setup and list require independent Tenant Admin authority and setup requires the live session fence', async () => {
  for (const principal of [
    { ...actor(), roles: ['employee'], permissions: ['request:read'] },
    { ...actor(), roles: ['conference_manager'], permissions: ['request:manage'] },
    { ...actor(), roles: ['conference_manager'] }, { ...actor(), permissions: [] },
    { ...actor(), tenantId: id(9) },
  ]) {
    const f = fixture();
    await assert.rejects(f.service.create({ ...command(), principal }));
    await assert.rejects(f.service.list({ ...context(), principal }));
    assert.deepEqual(f.calls, []);
  }
  for (const session of [undefined, {}, { id: id(3), securityVersion: 0 }]) {
    const f = fixture();
    await assert.rejects(f.service.create({ ...command(), principal: { ...actor(), session } }), /PRINCIPAL_NOT_AUTHORIZED/);
    assert.deepEqual(f.calls, []);
  }
  for (const status of ['suspended', 'archived', 'unknown']) {
    const f = fixture();
    await assert.rejects(f.service.create({ ...command(), tenantContext: { tenantId, status } }));
    assert.deepEqual(f.calls, []);
  }
});

test('setup rejects unknown or upgraded providers, malformed commands, credential fields and bad persistence outcomes', async () => {
  const f = fixture();
  for (const change of [{ schemaVersion: 2 }, { commandId: 'untrusted' }, { providerId: 'unknown' },
    { configuration: { ...configuration(), credentials: 'untrusted' } },
    { configuration: { ...configuration(), capabilities: { 'catering.order': 'api' } } }]) {
    await assert.rejects(f.service.create({ ...command(), ...change }));
  }
  assert.deepEqual(f.calls, []);
  for (const result of [{ status: 'not_authorized' }, { status: 'conflict', currentRevision: 1 }, { status: 'updated', current: null },
    { status: 'updated', current: { tenantId: id(9), integrationId: id(10), revision: 1, providerId: 'manual_catering' } }]) {
    const service = f.make({ repository: { ...f.repository, create: async () => result } });
    await assert.rejects(service.create(command()));
  }
});

test('list validates bounded ordered pages, foreign rows, continuation and provider binding before projecting results', async () => {
  const f = fixture();
  const normalized = normalizeCateringConfiguration(configuration(), f.registry.get('manual_catering'));
  const row = (n) => ({ tenantId, integrationId: id(n), providerId: 'manual_catering', revision: 1,
    configuration: { initialOrderMode: normalized.initialOrderMode, capabilities: normalized.capabilities },
    privateReference: 'never-project' });
  const page = (items, nextAfterIntegrationId = null) => f.make({ repository: { ...f.repository,
    listCurrent: async () => ({ items, nextAfterIntegrationId }) } });
  const valid = await page(Array.from({ length: 20 }, (_, i) => row(i + 10)), id(29)).list({ ...context(), afterIntegrationId: id(9) });
  assert.equal(valid.nextAfterIntegrationId, id(29));
  assert.equal(JSON.stringify(valid).includes('never-project'), false);
  for (const [items, next] of [[Array.from({ length: 21 }, (_, i) => row(i + 10)), null],
    [[row(11), row(10)], null], [[row(10), row(10)], null], [[{ ...row(10), tenantId: id(9) }], null],
    [[{ ...row(10), providerId: 'unknown' }], null], [[row(10)], id(10)]]) {
    await assert.rejects(page(items, next).list(context()));
  }
  await assert.rejects(page([row(10)]).list({ ...context(), afterIntegrationId: id(10) }));
  await assert.rejects(f.service.list({ ...context(), afterIntegrationId: 'invalid' }));
});

test('collection HTTP accepts only closed setup intent and bounded cursor query', async () => {
  const f = fixture();
  const csrf = [];
  const handler = createCateringConfigurationHttpHandler({ service: f.service,
    principalGuard: { async require(request, options) { csrf.push(options.csrf); return actor(); } },
    tenantGuard: { async requireKnown() { return context().tenantContext; } }, maxBodyBytes: 8192, maxResponseBytes: 65536 });
  const exchange = (method, suffix = '', body) => {
    const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.headers = { 'content-type': 'application/json' };
    const response = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
    const parsedUrl = new URL('/api/v1/integrations/catering' + suffix, 'https://synthetic.test');
    return { request, response, path: parsedUrl.pathname, parsedUrl, requestId: id(4) };
  };
  const { principal, tenantContext, correlationId, ...body } = command();
  assert.ok(principal && tenantContext && correlationId);
  const created = exchange('POST', '', body);
  assert.equal(await handler(created), 200);
  assert.equal(created.response.body.integrationId, id(10));
  const list = exchange('GET');
  assert.equal(await handler(list), 200);
  assert.equal(list.response.body.connections.length, 1);
  assert.deepEqual(csrf, [true, false]);
  for (const extra of [{ tenantId: id(9) }, { integrationId: id(9) }, { credentials: 'untrusted' }]) {
    await assert.rejects(handler(exchange('POST', '', { ...body, ...extra })), { code: 'VALIDATION_FAILED' });
  }
  for (const query of ['?tenantId=x', '?afterIntegrationId=x', `?afterIntegrationId=${id(9)}&afterIntegrationId=${id(9)}`]) {
    await assert.rejects(handler(exchange('GET', query)), { code: 'VALIDATION_FAILED' });
  }
  await assert.rejects(handler(exchange('DELETE')), { code: 'METHOD_NOT_ALLOWED' });
  await assert.rejects(handler(exchange('POST', '?afterIntegrationId=' + id(9), body)), { code: 'VALIDATION_FAILED' });
});
