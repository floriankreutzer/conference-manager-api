import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { cateringOperationalHealthRouteKey, createCateringOperationalHealthHttpHandler } from '../src/http/settings/catering-health.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const ROOT = `/api/v1/integrations/catering/${id(3)}/health`;
function fixture({ denied = false, ceiling = 196608, output = { schemaVersion: 1 } } = {}) {
  const calls = []; const guards = [];
  const handler = createCateringOperationalHealthHttpHandler({ maxResponseBytes: ceiling,
    service: { async current(input) { calls.push(input); return output; } },
    principalGuard: { async require(_request, options) {
      guards.push(options); if (denied) throw new ApiError(403, 'FORBIDDEN'); return { tenantId: id(1), userId: id(30) };
    } }, tenantGuard: { async requireKnown(principal) { return { tenantId: principal.tenantId, status: 'active' }; } } });
  async function invoke(method = 'GET', path = ROOT, body = '', headers = {}) {
    const bytes = Buffer.from(body); const request = Readable.from(bytes.length ? [bytes] : []); request.method = method;
    request.headers = { 'content-length': String(bytes.length), ...headers };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    return { pending: handler({ request, response: reply, path: parsedUrl.pathname, parsedUrl, requestId: id(90) }), reply };
  }
  return { calls, guards, invoke };
}
test('health HTTP binds trusted Tenant/actor/correlation and is a bodyless GET-only projection', async () => {
  const f = fixture(); const response = await f.invoke(); assert.equal(await response.pending, 200);
  assert.equal(f.calls[0].integrationId, id(3)); assert.equal(f.calls[0].principal.userId, id(30));
  assert.equal(f.calls[0].tenantContext.tenantId, id(1)); assert.equal(f.calls[0].correlationId, id(90));
  assert.equal(f.guards[0].csrf, false);
  assert.equal(response.reply.headers['Content-Length'], Buffer.byteLength(response.reply.body));
  assert.equal(response.reply.headers['Content-Type'], 'application/json; charset=utf-8');
  for (const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) {
    const output = await f.invoke(method); await assert.rejects(output.pending, (error) => error.statusCode === 405);
    assert.equal(output.reply.headers.Allow, 'GET');
  }
  assert.equal(f.calls.length, 1); assert.equal(f.guards[1].csrf, true);
});
test('health rejects authority/cursor/query/body input and denies before invoking the service', async () => {
  for (const query of ['tenantId=foreign','limit=1000000','providerId=manual_catering','afterJobId=x','x=1&x=2']) {
    const f = fixture(); await assert.rejects((await f.invoke('GET', `${ROOT}?${query}`)).pending,
      (error) => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
  for (const [body, headers] of [['{}', {}], ['', { 'content-length': '1' }], ['', { 'content-length': ['0','0'] }],
    ['', { 'content-length': 'invalid' }], ['x', { 'content-length': '0' }]]) {
    const f = fixture(); await assert.rejects((await f.invoke('GET', ROOT, body, headers)).pending,
      (error) => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
  const denied = fixture({ denied: true });
  await assert.rejects((await denied.invoke()).pending, (error) => error.statusCode === 403); assert.equal(denied.calls.length, 0);
});
test('unknown routes and multibyte response overflow cannot produce a health acknowledgement', async () => {
  const f = fixture();
  for (const path of [ROOT.toUpperCase(), `${ROOT}/`, ROOT.replace(id(3), 'foreign'), ROOT.replace('/health','/configuration')]) {
    assert.equal(cateringOperationalHealthRouteKey(path), null); assert.equal(await (await f.invoke('GET', path)).pending, null);
  }
  assert.equal(cateringOperationalHealthRouteKey(ROOT), 'catering_health');
  const bounded = fixture({ ceiling: 1024, output: { value: '界'.repeat(600) } }); const response = await bounded.invoke();
  await assert.rejects(response.pending, (error) => error.statusCode === 500 && error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(response.reply.body, undefined); assert.notEqual(response.reply.statusCode, 200);
});
