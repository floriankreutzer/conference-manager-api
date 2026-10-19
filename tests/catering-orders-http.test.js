import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { cateringOrderRouteKey, createCateringOrderHttpHandler } from '../src/http/catering-orders.js';

const ROOT = '/api/v1/tenant/catering/orders';
const id = (n) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = () => ({ schemaVersion: 1, requestId: 'request-a', commandId: id(3),
  expectedRequestVersion: 2, expectedAssignmentRevision: 3 });
function fixture(overrides = {}) {
  const calls = [];
  const guards = [];
  const service = Object.fromEntries(['load','list','prepare','recordQuote','decide'].map((method) => [method, async (input) => {
    calls.push({ method, input }); return { schemaVersion: 1, value: 'Übersicht' };
  }]));
  const handler = createCateringOrderHttpHandler({ service: { ...service, ...overrides.service },
    principalGuard: { async require(request, options) {
      guards.push(options); if (overrides.denied) throw new ApiError(403, 'FORBIDDEN');
      return { tenantId: id(1), userId: id(2) };
    } }, tenantGuard: { async requireActive(principal) { return { tenantId: principal.tenantId, status: 'active' }; } },
    maxBodyBytes: 8192, maxResponseBytes: overrides.maxResponseBytes ?? 524288 });
  async function invoke(method, path, body = undefined, headers = {}) {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const request = Readable.from(bytes.length ? [bytes] : []);
    request.method = method;
    request.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    const pending = handler({ request, response: reply, path: parsedUrl.pathname, parsedUrl, requestId: id(4) });
    return { pending, reply };
  }
  return { calls, guards, invoke };
}

test('order transport delegates server scope and unsafe-method CSRF, preserving independent CAS fields', async () => {
  const f = fixture();
  for (const [method, path, body, selected] of [
    ['GET', ROOT, undefined, 'list'], ['POST', ROOT, command(), 'prepare'],
    ['GET', `${ROOT}/${id(8)}`, undefined, 'load'],
    ['PUT', `${ROOT}/${id(8)}/quote`, { schemaVersion: 1, expectedStateRevision: 1, expectedQuoteRevision: 0,
      cost: { amountMinor: 1500, currency: 'EUR' }, expiresAt: '2026-10-20T10:00:00.000Z' }, 'recordQuote'],
    ['POST', `${ROOT}/${id(8)}/decision`, { schemaVersion: 1, expectedStateRevision: 2, expectedQuoteRevision: 1,
      decision: 'approved' }, 'decide'],
  ]) {
    const { pending, reply } = await f.invoke(method, path, body);
    assert.equal(await pending, 200);
    assert.equal(f.calls.at(-1).method, selected);
    assert.equal(f.calls.at(-1).input.principal.tenantId, id(1));
    assert.equal(f.calls.at(-1).input.tenantContext.tenantId, id(1));
    assert.equal(f.calls.at(-1).input.correlationId, id(4));
    assert.equal(f.guards.at(-1).csrf, method !== 'GET');
    assert.equal(reply.headers['Content-Length'], Buffer.byteLength(reply.body));
  }
  assert.equal(f.calls[1].input.expectedRequestVersion, 2);
  assert.equal(f.calls[1].input.expectedAssignmentRevision, 3);
  assert.equal(f.calls[3].input.expectedQuoteRevision, 0);
  assert.equal(f.calls[4].input.orderId, id(8));
});

test('authority-bearing and unknown top-level command fields fail before any use-case invocation', async () => {
  for (const extra of [{ tenantId: id(9) }, { actorUserId: id(9) }, { providerId: 'external' },
    { endpoint: 'https://untrusted.invalid' }, { status: 'confirmed' }, { approvedCost: 1 }]) {
    const f = fixture();
    const { pending } = await f.invoke('POST', ROOT, { ...command(), ...extra });
    await assert.rejects(pending, (error) => error.statusCode === 400);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  const { pending } = await f.invoke('POST', `${ROOT}/${id(8)}/decision`, { schemaVersion: 1,
    expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved', cost: { amountMinor: 0, currency: 'EUR' } });
  await assert.rejects(pending, (error) => error.statusCode === 400);
  assert.deepEqual(f.calls, []);
});

test('GETs reject bodies and ambiguous/unbounded query selectors while bounded filters remain explicit', async () => {
  for (const path of [`${ROOT}?afterOrderId=${id(8)}&afterOrderId=${id(9)}`, `${ROOT}?limit=1000`,
    `${ROOT}?requestId=../foreign`, `${ROOT}/${id(8)}?tenantId=${id(9)}`, `${ROOT}?afterOrderId=external`]) {
    const f = fixture(); const { pending } = await f.invoke('GET', path);
    await assert.rejects(pending, (error) => error.statusCode === 400); assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  const { pending } = await f.invoke('GET', `${ROOT}?afterOrderId=${id(8)}&requestId=request-a`);
  assert.equal(await pending, 200); assert.equal(f.calls[0].input.afterOrderId, id(8));
  const withBody = await f.invoke('GET', ROOT, {});
  await assert.rejects(withBody.pending, (error) => error.statusCode === 400);
});

test('method, content type, body and byte-response ceilings fail without a success acknowledgement', async () => {
  const f = fixture();
  const unsupported = await f.invoke('DELETE', `${ROOT}/${id(8)}`);
  await assert.rejects(unsupported.pending, (error) => error.statusCode === 405);
  assert.equal(unsupported.reply.headers.Allow, 'GET');
  const wrongType = await f.invoke('POST', ROOT, command(), { 'content-type': 'text/plain' });
  await assert.rejects(wrongType.pending, (error) => error.statusCode === 415);
  const large = await f.invoke('POST', ROOT, { ...command(), padding: 'a'.repeat(4096) });
  await assert.rejects(large.pending, (error) => error.statusCode === 413);
  const bounded = fixture({ maxResponseBytes: 1024, service: { load: async () => ({ value: '界'.repeat(600) }) } });
  const response = await bounded.invoke('GET', `${ROOT}/${id(8)}`);
  await assert.rejects(response.pending, (error) => error.statusCode === 500 && error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(response.reply.body, undefined); assert.notEqual(response.reply.statusCode, 200);
});

test('guard denial and unknown route spelling cannot reach order operations or invent metric dimensions', async () => {
  const f = fixture({ denied: true });
  const { pending } = await f.invoke('POST', ROOT, command());
  await assert.rejects(pending, (error) => error.statusCode === 403); assert.deepEqual(f.calls, []);
  for (const path of [`${ROOT}/external`, `${ROOT}/${id(8)}/QUOTE`, `${ROOT}/${id(8)}/decision/`, ROOT.toUpperCase()]) {
    assert.equal(cateringOrderRouteKey(path), null);
    const unknown = await f.invoke('GET', path); assert.equal(await unknown.pending, null);
  }
  assert.equal(cateringOrderRouteKey(`${ROOT}/${id(8)}/quote`), 'catering_order_quote');
});

test('historical reads and quote decisions carry canonical explicit order-version selectors', async () => {
  const f = fixture(); assert.equal(await (await f.invoke('GET', `${ROOT}/${id(8)}?orderVersion=2`)).pending, 200);
  assert.equal(f.calls[0].input.orderVersion, 2);
  for (const selector of ['0','01','1e2','9007199254740991','2&orderVersion=3']) {
    await assert.rejects((await f.invoke('GET', `${ROOT}/${id(8)}?orderVersion=${selector}`)).pending,
      (error) => error.statusCode === 400);
  }
  const quote = { schemaVersion: 1, expectedOrderVersion: 2, expectedStateRevision: 1, expectedQuoteRevision: 0,
    cost: { amountMinor: 1500, currency: 'EUR' }, expiresAt: '2026-10-20T10:00:00.000Z' };
  assert.equal(await (await f.invoke('PUT', `${ROOT}/${id(8)}/quote`, quote)).pending, 200);
  assert.equal(f.calls.at(-1).input.expectedOrderVersion, 2);
  assert.equal(await (await f.invoke('POST', `${ROOT}/${id(8)}/decision`, { schemaVersion: 1, expectedOrderVersion: 2,
    expectedStateRevision: 2, expectedQuoteRevision: 1, decision: 'approved' })).pending, 200);
  assert.equal(f.calls.at(-1).input.expectedOrderVersion, 2);
});
