import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRouteModuleRegistry } from '../src/http/route-module.js';
import {
  cateringCatalogueAssignmentRouteKey, createCateringCatalogueAssignmentHttpHandler, createCateringCatalogueAssignmentRouteModule,
} from '../src/http/catering-catalogue-assignments.js';

const id = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PATH = '/api/v1/tenant/catering/catalogue-assignments';
const CONNECTIONS = '/api/v1/tenant/catering/catalogue-connections';
function exchange(method = 'GET', path = PATH, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  request.method = method;
  request.headers = { 'content-type': 'application/json' };
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
  return { request, response, path: new URL(path, 'https://synthetic.test').pathname,
    parsedUrl: new URL(path, 'https://synthetic.test'), requestId: id(3) };
}
function fixture() {
  const calls = [];
  const guards = [];
  const principal = { tenantId: id(1), userId: id(2) };
  const tenantContext = { tenantId: id(1), status: 'active' };
  const service = Object.fromEntries(['current', 'replace', 'listConnections'].map((operation) => [operation,
    async (input) => { calls.push({ operation, input }); return { schemaVersion: 1 }; }]));
  const runtime = { principalGuard: { async require(request, options) { guards.push(options.csrf); return principal; } },
    tenantGuard: { async requireActive(actor) { assert.equal(actor, principal); return tenantContext; } },
    maxBodyBytes: 1024, maxResponseBytes: 1024 };
  const handler = createRouteModuleRegistry([createCateringCatalogueAssignmentRouteModule(service)]).createDispatcher(runtime);
  return { calls, guards, service, runtime, handler, principal, tenantContext };
}

test('Manager assignment routes are exact and preserve active Tenant/session/CSRF guard delegation', async () => {
  const f = fixture();
  assert.equal(cateringCatalogueAssignmentRouteKey(PATH), 'catering_catalogue_assignments');
  assert.equal(cateringCatalogueAssignmentRouteKey(CONNECTIONS), 'catering_catalogue_connections');
  for (const path of [PATH + '/', CONNECTIONS + '/other', '/api/v1/tenant/catering/unknown', null]) {
    assert.equal(cateringCatalogueAssignmentRouteKey(path), null);
  }
  assert.equal(await f.handler(exchange()), 200);
  const body = { schemaVersion: 1, expectedRevision: 0, catalogueRevision: 2,
    assignments: [{ kind: 'item', entryId: 'coffee', integrationId: id(5) }] };
  const call = exchange('PUT', PATH, JSON.stringify(body));
  assert.equal(await f.handler(call), 200);
  assert.deepEqual(f.guards, [false, true]);
  assert.deepEqual(f.calls[1], { operation: 'replace', input: {
    principal: f.principal, tenantContext: f.tenantContext, correlationId: id(3), ...body,
  } });
  assert.equal(call.response.headers['Content-Length'], Buffer.byteLength(call.response.body));
});

test('Manager connection lookup accepts one bounded UUID cursor and no Tenant/provider authority', async () => {
  const f = fixture();
  assert.equal(await f.handler(exchange('GET', CONNECTIONS + '?afterIntegrationId=' + id(5))), 200);
  assert.equal(f.calls[0].input.afterIntegrationId, id(5));
  for (const query of ['?tenantId=untrusted', '?afterIntegrationId=invalid', `?afterIntegrationId=${id(5)}&afterIntegrationId=${id(5)}`]) {
    await assert.rejects(f.handler(exchange('GET', CONNECTIONS + query)), { code: 'VALIDATION_FAILED' });
  }
  await assert.rejects(f.handler(exchange('PUT', CONNECTIONS, '{}')), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(f.calls.length, 1);
});

test('closed assignment commands reject unknown authority, malformed/body-oversize input and GET/query bodies', async () => {
  const f = fixture();
  const body = { schemaVersion: 1, expectedRevision: 0, catalogueRevision: 2, assignments: [] };
  for (const extra of [{ tenantId: id(9) }, { actorUserId: id(9) }, { approved: true }, { credentials: 'untrusted' }]) {
    await assert.rejects(f.handler(exchange('PUT', PATH, JSON.stringify({ ...body, ...extra }))), { code: 'VALIDATION_FAILED' });
  }
  for (const value of ['[]', '{', JSON.stringify({ ...body, assignments: Array.from({ length: 401 }, () => null) })]) {
    await assert.rejects(f.handler(exchange('PUT', PATH, value)));
  }
  await assert.rejects(f.handler(exchange('PUT', PATH, 'ä'.repeat(600))), { statusCode: 413, code: 'BODY_TOO_LARGE' });
  await assert.rejects(f.handler(exchange('GET', PATH, 'x')), { code: 'REQUEST_BODY_NOT_ALLOWED' });
  await assert.rejects(f.handler(exchange('GET', PATH + '?tenantId=untrusted')), { code: 'VALIDATION_FAILED' });
  assert.deepEqual(f.calls, []);
});

test('unsupported/unavailable paths and unbounded service output cannot emit successful assignment responses', async () => {
  const f = fixture();
  assert.equal(await f.handler(exchange('GET', '/unmatched')), null);
  const method = exchange('DELETE');
  await assert.rejects(f.handler(method), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(method.response.headers.Allow, 'GET, PUT');
  const absent = createCateringCatalogueAssignmentHttpHandler({ ...f.runtime, service: null });
  await assert.rejects(absent(exchange()), { code: 'CATERING_ASSIGNMENT_UNAVAILABLE' });
  const oversized = createCateringCatalogueAssignmentHttpHandler({ ...f.runtime,
    service: { ...f.service, current: async () => ({ invalid: 'x'.repeat(2000) }) } });
  const call = exchange();
  await assert.rejects(oversized(call), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(call.response.statusCode, undefined);
  assert.equal(call.response.body, undefined);
});
