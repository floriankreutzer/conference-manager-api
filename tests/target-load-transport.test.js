import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createTargetLoadTransport } from '../scripts/support/target-load-transport.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, RUN, NOW } from './support/target-load-environment.js';

const origins = Object.fromEntries(['customer', 'platform'].map(surface => [surface,
  `https://cm-saas38-load-${RUN}-${surface}.onrender.com`]));
const session = { kind: 'session_read', method: 'GET', path: '/api/v1/session', binary: false,
  cookie: `cm_session=${'c'.repeat(43)}` };
function fixture(options = {}) {
  const reservations = []; const calls = []; let mode = 'valid'; let now = NOW;
  const transport = createTargetLoadTransport({ values: targetScopeValues(targetLoadSetupEnvironment()), origins,
    clock: () => now, async recordAttempt(row) { reservations.push(row); await options.reserve?.(); },
    request(url, config, receive) {
      calls.push({ url, config }); assert.equal(reservations.length, calls.length);
      const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
        calls.at(-1).body = body;
        if (mode === 'error') { queueMicrotask(() => req.emit('error', new Error('private-network-material'))); return; }
        if (mode === 'stall') return;
        const bytes = mode === 'oversize' ? Buffer.alloc(8193) : mode === 'malformed' ? Buffer.from('private-invalid-json')
          : Buffer.from(mode.startsWith('denied') ? '{"error":{"code":"RESOURCE_NOT_AVAILABLE"}}' : '{"ok":true}');
        const response = Readable.from([bytes]);
        response.statusCode = mode.startsWith('denied') ? Number(mode.slice(6)) : mode === 'redirect' ? 302 : 200;
        response.headers = { 'content-type': mode === 'html' ? 'text/html' : 'application/json; charset=utf-8',
          ...(mode === 'encoding' ? { 'content-encoding': 'gzip' } : {}),
          ...(mode === 'redirect' ? { location: 'https://private.invalid' } : {}) };
        queueMicrotask(() => receive(response));
      }; return req;
    },
  });
  return { transport, calls, reservations, mode(value) { mode = value; }, clock(value) { now = value; } };
}

test('target transport fixes verified HTTPS destinations and reserves redacted aggregate before each send', async () => {
  const f = fixture();
  const response = await f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(response.body, { ok: true }); assert.equal(response.status, 200);
  const call = f.calls[0]; assert.equal(call.url.origin, origins.customer); assert.equal(call.url.pathname, session.path);
  assert.equal(call.config.rejectUnauthorized, true); assert.equal(call.config.agent, false);
  assert.equal(call.config.minVersion, 'TLSv1.2'); assert.equal(call.config.headers.Cookie, session.cookie);
  assert.equal(call.config.headers['Accept-Encoding'], 'identity');
  assert.deepEqual(f.reservations, [{ ordinal: 1, surface: 'customer', kind: 'session_read', method: 'GET',
    responseByteReservation: 8192, requestPayloadBytes: 0 }]);
  await f.transport.observe('platform', AbortSignal.timeout(1000));
  assert.equal(f.calls[1].url.origin, origins.platform); assert.equal(f.calls[1].url.pathname, '/__load/observe');
  assert.equal(f.calls[1].config.headers.Cookie, undefined);
  assert.match(f.calls[1].config.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(f.reservations).includes('Cookie'), false);
});

test('target transport rejects foreign routes, cookies, methods, signals and unknown surfaces before reservation', async () => {
  const f = fixture(); const base = { ...session, signal: AbortSignal.timeout(1000) };
  for (const change of [{ path: 'https://private.invalid' }, { path: '/api/v1/session#private' },
    { path: '/api/v1/session?foreign=true' }, { method: 'DELETE' }, { cookie: `${session.cookie}; foreign=x` },
    { binary: true }, { body: {} }, { expectedVersion: 1 }, { kind: '__proto__' }, { signal: undefined }, { timeoutMs: 999_999 }]) {
    await assert.rejects(f.transport.exchange({ ...base, ...change }), /^Error: LOAD_TARGET_HTTP_FAILED$/);
  }
  await assert.rejects(f.transport.observe('setup', base.signal));
  assert.equal(f.calls.length, 0); assert.equal(f.reservations.length, 0);
});

test('redirects, encodings, oversized and malformed bodies and private network errors never retry or reveal details', async () => {
  const f = fixture();
  for (const mode of ['redirect', 'encoding', 'oversize', 'malformed', 'html', 'error']) {
    f.mode(mode); const before = f.calls.length;
    await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }),
      /^Error: LOAD_TARGET_HTTP_FAILED$/);
    assert.equal(f.calls.length, before + 1); assert.equal(f.transport.snapshot().inFlight, 0);
  }
  assert.equal(f.transport.snapshot().attempts, 6);
});

test('failed durable reservation permanently closes transport before any network I/O', async () => {
  const f = fixture({ async reserve() { throw new Error('private-journal-material'); } });
  await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  assert.equal(f.reservations.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.transport.snapshot().closed, true);
});

test('abort drains one admitted request; expiry and backwards clocks cannot reopen admission', async () => {
  const f = fixture(); f.mode('stall'); const abort = new AbortController();
  const pending = f.transport.exchange({ ...session, signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await assert.rejects(pending);
  assert.equal(f.transport.snapshot().inFlight, 0); assert.equal(f.calls.length, 1);
  f.clock(NOW - 1); await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  f.clock(NOW); await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  assert.equal(f.calls.length, 1);
  const expired = fixture(); expired.clock(NOW + 540_000);
  await assert.rejects(expired.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  assert.equal(expired.calls.length, 0);
});

test('first protected probes have a separate one-attempt cold allowance before any business traffic', async () => {
  const f = fixture();
  await f.transport.coldObserve('customer', AbortSignal.timeout(1000));
  await f.transport.coldObserve('platform', AbortSignal.timeout(1000));
  assert.equal(f.reservations.every(row => row.kind === 'observer_cold_read'), true);
  await assert.rejects(f.transport.coldObserve('customer', AbortSignal.timeout(1000)));
  await f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) });
  await assert.rejects(f.transport.coldObserve('platform', AbortSignal.timeout(1000)));
  assert.equal(f.calls.length, 3);
});

test('concurrent requests cannot exceed sixteen admitted operations and abort releases every slot', async () => {
  const f = fixture(); f.mode('stall'); const controllers = Array.from({ length: 16 }, () => new AbortController());
  const pending = controllers.map(controller => f.transport.exchange({ ...session, signal: controller.signal }));
  await assert.rejects(f.transport.exchange({ ...session, signal: AbortSignal.timeout(1000) }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 16); assert.equal(f.reservations.length, 16);
  controllers.forEach(controller => controller.abort());
  assert.equal((await Promise.allSettled(pending)).every(row => row.status === 'rejected'), true);
  assert.equal(f.transport.snapshot().inFlight, 0); assert.equal(f.transport.snapshot().attempts, 16);
});

test('negative probes fix foreign, missing-CSRF and stale-version denials and discard response details', async () => {
  const f = fixture(); const base = { requestId: '11111111-1111-4111-8111-111111111111', cookie: session.cookie,
    csrfToken: 's'.repeat(43), signal: AbortSignal.timeout(1000) };
  for (const [probe, status] of [['foreign_read', 404], ['missing_csrf', 403], ['stale_version', 409]]) {
    f.mode(`denied${status}`); const result = await f.transport.negativeProbe({ ...base, probe });
    assert.equal(result.status, status); assert.equal(Object.hasOwn(result, 'body'), false);
    assert.equal(f.reservations.at(-1).kind, `negative_${probe}`);
    const call = f.calls.at(-1);
    assert.equal(call.config.headers['X-CSRF-Token'], probe === 'stale_version' ? base.csrfToken : undefined);
    assert.equal(call.config.method, probe === 'foreign_read' ? 'GET' : 'POST');
  }
  f.mode('valid'); await assert.rejects(f.transport.negativeProbe({ ...base, probe: 'stale_version' }));
  const count = f.calls.length;
  await assert.rejects(f.transport.negativeProbe({ ...base, probe: 'foreign_read', requestId: '../session' }));
  await assert.rejects(f.transport.negativeProbe({ ...base, probe: 'delete' })); assert.equal(f.calls.length, count);
});
