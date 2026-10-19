import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { cateringVersionRouteKey, createCateringVersionHttpHandler } from '../src/http/catering-order-versions.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const ROOT = `/api/v1/tenant/catering/orders/${id(5)}/versions`;
const command = () => ({ schemaVersion: 1, commandId: id(7), expectedOrderVersion: 1, expectedStateRevision: 6,
  expectedRequestVersion: 2, expectedAssignmentRevision: 2, operation: 'change', justification: 'Synthetic changed schedule' });
function fixture({ denied = false, ceiling = 196608, output = { schemaVersion: 1 } } = {}) {
  const calls = []; const guards = [];
  const service = Object.fromEntries(['load','propose'].map((method) => [method, async (input) => {
    calls.push({ method, input }); return output;
  }]));
  const handler = createCateringVersionHttpHandler({ service, maxBodyBytes: 16384, maxResponseBytes: ceiling,
    principalGuard: { async require(_request, options) {
      guards.push(options); if (denied) throw new ApiError(403, 'FORBIDDEN'); return { tenantId: id(1), userId: id(20) };
    } }, tenantGuard: { async requireActive(principal) { return { tenantId: principal.tenantId, status: 'active' }; } } });
  async function invoke(method, path = ROOT, body, headers = {}) {
    const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const request = Readable.from(bytes.length ? [bytes] : []); request.method = method;
    request.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length), ...headers };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
    const parsedUrl = new URL(path, 'http://localhost:3000');
    return { pending: handler({ request, response: reply, path: parsedUrl.pathname, parsedUrl, requestId: id(90) }), reply };
  }
  return { calls, guards, invoke };
}

test('version HTTP binds trusted Manager scope and canonical correlation with unsafe-method CSRF', async () => {
  const f = fixture();
  assert.equal(await (await f.invoke('GET')).pending, 200);
  assert.equal(f.calls[0].input.afterOrderVersion, 1); assert.equal(f.guards[0].csrf, false);
  const created = await f.invoke('POST', ROOT, command()); assert.equal(await created.pending, 200);
  assert.equal(f.guards[1].csrf, true); assert.equal(f.calls[1].method, 'propose');
  assert.equal(f.calls[1].input.orderId, id(5)); assert.equal(f.calls[1].input.principal.userId, id(20));
  assert.equal(f.calls[1].input.tenantContext.tenantId, id(1)); assert.equal(f.calls[1].input.correlationId, id(90));
  assert.equal(created.reply.headers['Content-Length'], Buffer.byteLength(created.reply.body));
});

test('version HTTP rejects authority, price and unknown fields before the use case', async () => {
  for (const extra of [{ tenantId: id(99) }, { actorUserId: id(99) }, { basisOrderVersion: 1 }, { status: 'confirmed' },
    { cost: { amountMinor: 0, currency: 'EUR' } }, { operation: 'initial' }, { providerUrl: 'https://synthetic.invalid' }]) {
    const f = fixture(); const response = await f.invoke('POST', ROOT, { ...command(), ...extra });
    await assert.rejects(response.pending, (error) => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
  const denied = fixture({ denied: true });
  await assert.rejects((await denied.invoke('POST', ROOT, command())).pending, (error) => error.statusCode === 403);
  assert.equal(denied.calls.length, 0);
});

test('version history accepts only one canonical positive cursor and bodyless reads', async () => {
  for (const query of ['afterOrderVersion=0','afterOrderVersion=01','afterOrderVersion=1e2',
    'afterOrderVersion=9007199254740991','afterOrderVersion=1&afterOrderVersion=2','tenantId=foreign','limit=1000']) {
    const f = fixture(); await assert.rejects((await f.invoke('GET', `${ROOT}?${query}`)).pending,
      (error) => error.statusCode === 400); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); assert.equal(await (await f.invoke('GET', `${ROOT}?afterOrderVersion=21`)).pending, 200);
  assert.equal(f.calls[0].input.afterOrderVersion, 21);
  await assert.rejects((await f.invoke('GET', ROOT, {})).pending, (error) => error.statusCode === 400);
  await assert.rejects((await f.invoke('POST', `${ROOT}?afterOrderVersion=1`, command())).pending,
    (error) => error.statusCode === 400);
});

test('version route/method/media/body/UTF8 response ceilings cannot become successful acknowledgments', async () => {
  const f = fixture(); const unsupported = await f.invoke('DELETE');
  await assert.rejects(unsupported.pending, (error) => error.statusCode === 405);
  assert.equal(unsupported.reply.headers.Allow, 'GET, POST');
  await assert.rejects((await f.invoke('POST', ROOT, command(), { 'content-type': 'text/plain' })).pending,
    (error) => error.statusCode === 415);
  await assert.rejects((await f.invoke('POST', ROOT, { ...command(), justification: 'x'.repeat(8192) })).pending,
    (error) => error.statusCode === 413);
  const bounded = fixture({ ceiling: 1024, output: { value: '界'.repeat(600) } }); const response = await bounded.invoke('GET');
  await assert.rejects(response.pending, (error) => error.statusCode === 500 && error.code === 'RESPONSE_TOO_LARGE');
  assert.equal(response.reply.body, undefined); assert.notEqual(response.reply.statusCode, 200);
  for (const path of [ROOT.toUpperCase(), `${ROOT}/`, ROOT.replace(id(5), 'foreign')]) {
    assert.equal(cateringVersionRouteKey(path), null); assert.equal(await (await f.invoke('GET', path)).pending, null);
  }
  assert.equal(cateringVersionRouteKey(ROOT), 'catering_order_versions');
});
