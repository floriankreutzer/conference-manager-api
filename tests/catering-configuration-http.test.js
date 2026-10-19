import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { createCateringConfigurationService } from '../src/application/catering-configuration-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { createRouteModuleRegistry } from '../src/http/route-module.js';
import {
  cateringConfigurationRouteKey, cateringConfigurationRouteModule, createCateringConfigurationHttpHandler,
} from '../src/http/settings/catering-integrations.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = (number) => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const PATH = `/api/v1/integrations/catering/${id(3)}/configuration`;
const ORIGIN = 'https://conference.test';
const proposed = () => ({
  schemaVersion: 1, expectedRevision: 1,
  configuration: { initialOrderMode: 'after_conference_approval', capabilities: { 'catering.order': 'api' } },
});

function fixture() {
  const state = { actor: {
    tenantId: id(1), userId: id(4), roles: ['tenant_admin'], permissions: ['tenant:integrations:manage'],
    session: { id: id(5), securityVersion: 1 },
  }, revision: 1, guardCalls: [], reads: [], writes: [] };
  let configuration = { initialOrderMode: 'manager_review', capabilities: { 'catering.order': 'api' } };
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [
    { id: 'reference_caterer', runtime: 'production', capabilities: { 'catering.order': 'api' } },
  ] });
  const current = () => ({ tenantId: id(1), integrationId: id(3), providerId: 'reference_caterer',
    revision: state.revision, configuration, credentialReference: 'server-only-reference' });
  const service = createCateringConfigurationService({
    registry, authorizationPolicy, auditService: audit.service,
    repository: {
      async loadCurrent(input) {
        state.reads.push(input);
        return input.tenantId === id(1) && input.integrationId === id(3) ? current() : null;
      },
      async update(input) {
        state.writes.push(input);
        if (input.expectedRevision !== state.revision) return { status: 'conflict', currentRevision: state.revision };
        input.auditEventFor({ revision: state.revision + 1 });
        configuration = input.configuration;
        state.revision += 1;
        return { status: 'updated', current: current() };
      },
    },
  });
  const principalGuard = { async require(request, options) {
    state.guardCalls.push(options);
    if (state.actor === null) throw new ApiError(401, 'UNAUTHENTICATED');
    if (options.csrf && request.headers['x-csrf-token'] !== 'synthetic-csrf') throw new ApiError(403, 'CSRF_INVALID');
    return state.actor;
  } };
  const tenantGuard = { async requireKnown(actor) { return { tenantId: actor.tenantId, status: 'active' }; } };
  const runtime = { cateringConfigurationService: service, principalGuard, tenantGuard, maxBodyBytes: 1024, maxResponseBytes: 1024 };
  const handler = createRouteModuleRegistry([cateringConfigurationRouteModule]).createDispatcher(runtime);
  return { state, handler, runtime, service };
}

function exchange(method = 'GET', path = PATH, body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  request.method = method;
  request.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(value) { this.body = value; } };
  return { request, response, path: new URL(path, ORIGIN).pathname,
    parsedUrl: new URL(path, ORIGIN), requestId: id(9) };
}

test('route module is bounded to canonical owned Integration configuration paths', () => {
  assert.equal(cateringConfigurationRouteKey(PATH), 'catering_configuration');
  assert.equal(cateringConfigurationRouteKey(PATH.toUpperCase()), null);
  assert.equal(cateringConfigurationRouteKey(PATH.replace(id(3), id(3).toUpperCase())), 'catering_configuration');
  for (const path of [null, '', PATH + '/', PATH + '/history', PATH.replace(id(3), 'invalid'),
    '/api/v1/integrations/microsoft365', PATH.replace('4000', '9000')]) {
    assert.equal(cateringConfigurationRouteKey(path), null);
  }
});

test('GET projects only safe configuration and derives Tenant exclusively through the guards', async () => {
  const f = fixture();
  const call = exchange('GET', PATH, undefined, { 'x-tenant-id': id(2) });
  assert.equal(await f.handler(call), 200);
  assert.deepEqual(f.state.guardCalls, [{ csrf: false }]);
  assert.deepEqual(f.state.reads, [{ tenantId: id(1), integrationId: id(3) }]);
  const result = JSON.parse(call.response.body);
  assert.deepEqual(Object.keys(result).sort(), ['configuration', 'integrationId', 'providerId', 'revision', 'schemaVersion']);
  assert.equal(call.response.body.includes('server-only-reference'), false);
  assert.equal(call.response.headers['Content-Length'], Buffer.byteLength(call.response.body));
  assert.equal(call.response.headers['Content-Type'], 'application/json; charset=utf-8');
});

test('PUT requires the guard CSRF check and forwards only the closed versioned command', async () => {
  const f = fixture();
  await assert.rejects(f.handler(exchange('PUT', PATH, JSON.stringify(proposed()))), { code: 'CSRF_INVALID' });
  assert.equal(f.state.writes.length, 0);
  const call = exchange('PUT', PATH, JSON.stringify(proposed()), { 'x-csrf-token': 'synthetic-csrf' });
  assert.equal(await f.handler(call), 200);
  assert.deepEqual(f.state.guardCalls, [{ csrf: true }, { csrf: true }]);
  assert.equal(f.state.writes[0].tenantId, id(1));
  assert.equal(f.state.writes[0].actorUserId, id(4));
  assert.equal(f.state.writes[0].sessionId, id(5));
  assert.equal(f.state.writes[0].correlationId, id(9));
  assert.equal(JSON.parse(call.response.body).revision, 2);
});

test('authentication, Manager-only authority, foreign scope and stale versions cannot mutate through the port', async () => {
  const f = fixture();
  f.state.actor = { ...f.state.actor, roles: ['conference_manager'], permissions: ['request:manage'] };
  await assert.rejects(f.handler(exchange()), /PERMISSION_REQUIRED/);
  assert.equal(f.state.reads.length, 0);
  f.state.actor = null;
  await assert.rejects(f.handler(exchange()), { code: 'UNAUTHENTICATED' });
  const other = fixture();
  other.state.actor.tenantId = id(2);
  await assert.rejects(other.handler(exchange()), (error) => error.conceal === true);
  assert.equal(other.state.writes.length, 0);
  const stale = fixture();
  stale.state.revision = 2;
  await assert.rejects(stale.handler(exchange('PUT', PATH, JSON.stringify(proposed()),
    { 'x-csrf-token': 'synthetic-csrf' })), /TENANT_SETTINGS_REVISION_CONFLICT/);
  assert.equal(stale.state.writes.length, 0);
});

test('query/body authority, unknown configuration, invalid JSON/type and oversized bodies fail before mutation', async () => {
  for (const extra of [{ tenantId: id(2) }, { providerId: 'other' }, { sessionId: id(8) }, { credentials: 'untrusted' }]) {
    const f = fixture();
    await assert.rejects(f.handler(exchange('PUT', PATH, JSON.stringify({ ...proposed(), ...extra }),
      { 'x-csrf-token': 'synthetic-csrf' })), { code: 'VALIDATION_FAILED' });
    assert.equal(f.state.writes.length, 0);
  }
  for (const [path, body, headers] of [
    [PATH + '?tenantId=other', undefined, {}], [PATH, '{', {}], [PATH, '[]', {}],
    [PATH, JSON.stringify(proposed()), { 'content-type': 'text/plain' }],
    [PATH, JSON.stringify({ ...proposed(), configuration: { ...proposed().configuration, health: 'healthy' } }), {}],
  ]) {
    const f = fixture();
    await assert.rejects(f.handler(exchange('PUT', path, body, { 'x-csrf-token': 'synthetic-csrf', ...headers })));
    assert.equal(f.state.writes.length, 0);
  }
});

test('body bounds count bytes and reject compression before invoking the configuration service', async () => {
  for (const mode of ['x'.repeat(1100), 'ä'.repeat(600)]) {
    const f = fixture();
    const body = JSON.stringify({ ...proposed(), configuration: { ...proposed().configuration, initialOrderMode: mode } });
    await assert.rejects(f.handler(exchange('PUT', PATH, body, { 'x-csrf-token': 'synthetic-csrf' })),
      { statusCode: 413, code: 'BODY_TOO_LARGE' });
    assert.deepEqual(f.state.reads, []);
    assert.deepEqual(f.state.writes, []);
  }
  const f = fixture();
  await assert.rejects(f.handler(exchange('PUT', PATH, JSON.stringify(proposed()),
    { 'x-csrf-token': 'synthetic-csrf', 'content-encoding': 'gzip' })), { code: 'CONTENT_ENCODING_NOT_ALLOWED' });
  assert.deepEqual(f.state.reads, []);
});

test('GET bodies, unsupported methods, unmatched paths and unavailable service never call business operations', async () => {
  const f = fixture();
  for (const headers of [{}, { 'content-length': '0' }, { 'content-length': '1' }, { 'content-length': ['0'] }]) {
    await assert.rejects(f.handler(exchange('GET', PATH, 'x', headers)), { code: 'REQUEST_BODY_NOT_ALLOWED' });
  }
  const unsupported = exchange('DELETE', PATH, undefined, { 'x-csrf-token': 'synthetic-csrf' });
  await assert.rejects(f.handler(unsupported), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(unsupported.response.headers.Allow, 'GET, PUT');
  assert.equal(await f.handler(exchange('GET', '/unmatched')), null);
  assert.deepEqual(f.state.reads, []);
  assert.deepEqual(f.state.writes, []);
  const absent = createCateringConfigurationHttpHandler({ ...f.runtime, service: null });
  await assert.rejects(absent(exchange()), { code: 'CATERING_CONFIGURATION_UNAVAILABLE' });
});

test('response bounds are checked before emitting success or exposing an unbounded service result', async () => {
  const f = fixture();
  const handler = createCateringConfigurationHttpHandler({ ...f.runtime,
    service: { current: async () => ({ invalid: 'x'.repeat(2000) }), update: f.service.update } });
  const call = exchange();
  await assert.rejects(handler(call), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(call.response.statusCode, undefined);
  assert.equal(call.response.body, undefined);
});
