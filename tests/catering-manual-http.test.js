import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCateringManualDeliveryHttpHandler, cateringManualRouteKey } from '../src/http/catering-manual-delivery.js';

const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOT = `/api/v1/tenant/catering/orders/${id(5)}/manual-delivery`;
const command = () => ({ schemaVersion: 1, commandId: id(6), expectedOrderVersion: 1, expectedStateRevision: 4,
  kind: 'transmitted', channel: 'telephone', reference: 'Synthetic conversation #1',
  occurredAt: '2026-10-19T13:00:00.000Z', receipt: null });
function fixture({ maxResponseBytes = 786432, large = false } = {}) {
  const calls = []; const csrf = [];
  const service = Object.fromEntries(['load','record'].map((method) => [method, async (value) => {
    calls.push({ method, value }); return { value: large ? '界'.repeat(600) : 'safe' };
  }]));
  const handler = createCateringManualDeliveryHttpHandler({ service, maxBodyBytes: 65536, maxResponseBytes,
    principalGuard: { async require(_request, options) { csrf.push(options.csrf); return { tenantId: id(1), userId: id(20) }; } },
    tenantGuard: { async requireActive(principal) { return { tenantId: principal.tenantId, status: 'active' }; } } });
  function invoke(method, path = ROOT, body, headers = {}) {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const request = Readable.from(bytes.length ? [bytes] : []); request.method = method;
    request.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    return { pending: handler({ request, response: reply, path: parsedUrl.pathname, parsedUrl, requestId: id(90) }), reply };
  }
  return { calls, csrf, invoke };
}

test('manual delivery transport injects scoped principal/order and exact CSRF-protected attestation without sending', async () => {
  const f = fixture();
  assert.equal(await f.invoke('GET',`${ROOT}?orderVersion=1&afterSequence=20`).pending, 200);
  assert.equal(await f.invoke('POST',ROOT,command()).pending, 200);
  assert.deepEqual(f.csrf, [false,true]); assert.deepEqual(f.calls.map((call) => call.method), ['load','record']);
  assert.equal(f.calls[0].value.orderId, id(5)); assert.equal(f.calls[0].value.orderVersion, 1);
  assert.equal(f.calls[0].value.afterSequence, 20); assert.equal(f.calls[1].value.tenantContext.tenantId, id(1));
  assert.equal(f.calls[1].value.correlationId, id(90)); assert.equal(f.calls[1].value.reference, command().reference);
});

test('manual command transport rejects client Tenant/actor/provider/cost/session authority and arbitrary payloads', async () => {
  for (const extra of [{ tenantId: id(99) }, { actorUserId: id(99) }, { orderId: id(99) }, { providerId: 'external' },
    { cost: 1200 }, { sessionId: id(99) }, { status: 'confirmed' }, { payload: {} }, { credential: 'synthetic' }]) {
    const f = fixture(); await assert.rejects(f.invoke('POST',ROOT,{ ...command(), ...extra }).pending,
      (error) => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
});

test('manual history rejects duplicate, unknown, noncanonical and unbounded selectors and GET bodies', async () => {
  for (const query of ['?orderVersion=0','?orderVersion=01','?afterSequence=-1','?afterSequence=1.0',
    '?orderVersion=1&orderVersion=2','?limit=1000','?tenantId=foreign','?afterSequence=9007199254740991']) {
    const f = fixture(); await assert.rejects(f.invoke('GET',ROOT + query).pending, (error) => error.statusCode === 400);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await assert.rejects(f.invoke('GET',ROOT,{}).pending, (error) => error.statusCode === 400);
  await assert.rejects(f.invoke('POST',`${ROOT}?orderVersion=1`,command()).pending, (error) => error.statusCode === 400);
});

test('manual transport preserves method/media/byte bounds and cannot acknowledge a truncated response', async () => {
  const f = fixture(); const unsupported = f.invoke('DELETE');
  await assert.rejects(unsupported.pending, (error) => error.statusCode === 405);
  assert.equal(unsupported.reply.headers.Allow, 'GET, POST');
  await assert.rejects(f.invoke('POST',ROOT,command(),{ 'content-type': 'text/plain' }).pending,
    (error) => error.statusCode === 415);
  await assert.rejects(f.invoke('POST',ROOT,{ ...command(), padding: 'x'.repeat(40960) }).pending,
    (error) => error.statusCode === 413);
  const bounded = fixture({ maxResponseBytes: 1024, large: true }).invoke('GET');
  await assert.rejects(bounded.pending, (error) => error.code === 'RESPONSE_TOO_LARGE'); assert.equal(bounded.reply.body, undefined);
  for (const path of [ROOT + '/',ROOT.toUpperCase(),ROOT.replace(id(5), 'foreign'),ROOT + '/send']) {
    assert.equal(cateringManualRouteKey(path), null); assert.equal(await f.invoke('GET',path).pending, null);
  }
});
