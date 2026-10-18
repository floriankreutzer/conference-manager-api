import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createLoopbackBookingExchange } from '../scripts/support/loopback-booking-exchange.mjs';

const input = { kind: 'session_read', actor: 'employee', path: '/api/v1/session', method: 'GET',
  cookie: `cm_session=${'a'.repeat(43)}`, binary: false, signal: new AbortController().signal };

test('loopback choreography transport rejects destination, path, header and method escape before I/O', async () => {
  for (const origin of ['https://example.com', 'http://localhost:1', 'http://127.0.0.1:1?x=1',
    'http://user:secret@127.0.0.1:1', 'private-invalid-value']) {
    assert.throws(() => createLoopbackBookingExchange(origin), /^Error: LOAD_BOOKING_TRANSPORT_INVALID$/);
  }
  const exchange = createLoopbackBookingExchange('http://127.0.0.1:1');
  for (const value of [undefined, null]) await assert.rejects(exchange(value), /^Error: LOAD_BOOKING_TRANSPORT_FAILED$/);
  for (const patch of [{ path: 'https://example.com' }, { path: '/api/v1/session?tenant=foreign' },
    { method: 'POST' }, { actor: 'platform' }, { cookie: input.cookie + '\r\nInjected: true' }, { binary: true }]) {
    await assert.rejects(exchange({ ...input, ...patch }), /^Error: LOAD_BOOKING_TRANSPORT_FAILED$/);
  }
  for (const body of [{ transition: 'cancel' }, { transition: 'confirm' },
    { transition: 'start_review', tenantId: 'untrusted' }, null, () => {}]) {
    await assert.rejects(exchange({ ...input, kind: 'request_transition', method: 'POST',
      path: '/api/v1/requests/11111111-1111-4111-8111-111111111111/transitions',
      csrfToken: 'b'.repeat(43), expectedVersion: 1, body }), /^Error: LOAD_BOOKING_TRANSPORT_FAILED$/);
  }
});

test('loopback choreography transport reads bounded JSON and fails without redirect/retry', async () => {
  let failure; let calls = 0;
  const server = createServer((request, response) => {
    calls += 1; assert.equal(request.method, 'GET'); assert.equal(request.url, input.path);
    assert.equal(request.headers.cookie, input.cookie);
    if (failure === 'redirect') { response.writeHead(302, { Location: 'https://example.com' }); response.end(); return; }
    response.setHeader('Content-Type', failure === 'type' ? 'text/html' : 'application/json; charset=utf-8');
    response.end(failure === 'large' ? 'x'.repeat(8193) : failure === 'json' ? '{' : '{"schemaVersion":1}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const exchange = createLoopbackBookingExchange(`http://127.0.0.1:${server.address().port}`);
    const result = await exchange(input); assert.deepEqual(result.body, { schemaVersion: 1 });
    assert.equal(result.payloadBytes, 19); assert.equal(result.requestPayloadBytes, 0);
    for (failure of ['redirect', 'type', 'large', 'json']) {
      const before = calls; await assert.rejects(exchange(input), /^Error: LOAD_BOOKING_TRANSPORT_FAILED$/);
      assert.equal(calls, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
