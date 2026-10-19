import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCateringDeliveryHttpHandler, cateringDeliveryRouteKey } from '../src/http/catering-delivery-jobs.js';

const ROOT = '/api/v1/tenant/catering/delivery-jobs';
const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = () => ({ schemaVersion: 1, orderId: id(5), expectedOrderVersion: 1,
  expectedStateRevision: 3, expectedQuoteRevision: 1 });
function fixture({ maxResponseBytes = 65536, large = false } = {}) {
  const calls = []; const csrf = [];
  const service = Object.fromEntries(['load','list','enqueue'].map((method) => [method, async (value) => {
    calls.push({ method, value }); return { value: large ? '界'.repeat(600) : 'safe' };
  }]));
  const handler = createCateringDeliveryHttpHandler({ service, maxResponseBytes, maxBodyBytes: 8192,
    principalGuard: { async require(_request, options) { csrf.push(options.csrf); return { tenantId: id(1), userId: id(20) }; } },
    tenantGuard: { async requireActive(principal) { return { tenantId: principal.tenantId, status: 'active' }; } } });
  function invoke(method, path, body, headers = {}) {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const request = Readable.from(bytes.length ? [bytes] : []); request.method = method;
    request.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    return { pending: handler({ request, response: reply, path: parsedUrl.pathname, parsedUrl, requestId: id(90) }), reply };
  }
  return { calls, csrf, invoke };
}

test('delivery transport delegates trusted scope and CSRF with exact source revisions', async () => {
  const f = fixture();
  for (const [method,path,body] of [['GET',ROOT],['GET',`${ROOT}/${id(6)}`],['POST',ROOT,command()]]) {
    assert.equal(await f.invoke(method,path,body).pending, 200);
  }
  assert.deepEqual(f.calls.map((call) => call.method), ['list','load','enqueue']);
  assert.deepEqual(f.csrf, [false,false,true]);
  assert.equal(f.calls[2].value.tenantContext.tenantId, id(1));
  assert.equal(f.calls[2].value.expectedOrderVersion, 1); assert.equal(f.calls[2].value.expectedQuoteRevision, 1);
});

test('delivery commands reject authority, credential, payload, cost and invented operation fields', async () => {
  for (const extra of [{ tenantId: id(99) }, { actorUserId: id(99) }, { jobId: id(99) }, { providerId: 'external' },
    { endpoint: 'https://untrusted.invalid' }, { credential: 'synthetic' }, { receipt: {} }, { cost: 0 }, { operation: 'cancel' }]) {
    const f = fixture(); await assert.rejects(f.invoke('POST',ROOT,{ ...command(), ...extra }).pending,
      (error) => error.statusCode === 400); assert.deepEqual(f.calls, []);
  }
});

test('delivery reads reject GET bodies, duplicate selectors and arbitrary collection bounds', async () => {
  for (const path of [`${ROOT}?afterJobId=${id(8)}&afterJobId=${id(9)}`,`${ROOT}?limit=1000`,
    `${ROOT}?tenantId=${id(99)}`,`${ROOT}?orderId=external`,`${ROOT}/${id(6)}?orderId=${id(5)}`]) {
    const f = fixture(); await assert.rejects(f.invoke('GET',path).pending, (error) => error.statusCode === 400);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); await assert.rejects(f.invoke('GET',ROOT,{}).pending, (error) => error.statusCode === 400);
  assert.equal(await f.invoke('GET',`${ROOT}?afterJobId=${id(2)}&orderId=${id(5)}`).pending, 200);
  assert.equal(f.calls[0].value.orderId, id(5));
});

test('delivery methods, body/media and response byte limits retain fail-closed acknowledgement', async () => {
  const f = fixture(); const unsupported = f.invoke('DELETE',`${ROOT}/${id(6)}`);
  await assert.rejects(unsupported.pending, (error) => error.statusCode === 405); assert.equal(unsupported.reply.headers.Allow, 'GET');
  await assert.rejects(f.invoke('POST',ROOT,command(),{ 'content-type': 'text/plain' }).pending,
    (error) => error.statusCode === 415);
  await assert.rejects(f.invoke('POST',ROOT,{ ...command(), padding: 'x'.repeat(4096) }).pending,
    (error) => error.statusCode === 413);
  const bounded = fixture({ maxResponseBytes: 1024, large: true }).invoke('GET',`${ROOT}/${id(6)}`);
  await assert.rejects(bounded.pending, (error) => error.code === 'RESPONSE_TOO_LARGE'); assert.equal(bounded.reply.body, undefined);
  for (const path of [`${ROOT}/external`,`${ROOT}/${id(6)}/receipt`,`${ROOT}/${id(6)}/`,ROOT.toUpperCase()]) {
    assert.equal(cateringDeliveryRouteKey(path), null); assert.equal(await f.invoke('GET',path).pending, null);
  }
});
