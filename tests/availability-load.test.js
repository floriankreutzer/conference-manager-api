import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { measureRoomAvailability } from '../scripts/session-load-evidence.mjs';

const cookie = `cm_session=${'a'.repeat(43)}`; const token = 'b'.repeat(43);
const slot = { startsAt: '2026-10-30T09:00:00.000Z', endsAt: '2026-10-30T10:00:00.000Z' };
const options = { origin: 'http://127.0.0.1:1', ...slot, cookies: [cookie], csrfTokens: [token], verify() {} };

test('availability load rejects noncanonical slots, missing CSRF, oversized batches and non-loopback destinations', async () => {
  for (const patch of [{ startsAt: 'invalid' }, { endsAt: slot.startsAt }, { startsAt: '2026-10-30T09:00:00Z' },
    { endsAt: '2026-11-01T10:00:00.000Z' }, { csrfTokens: [] }, { csrfTokens: ['bad\r\nheader'] },
    { cookies: Array(1001).fill(cookie), csrfTokens: Array(1001).fill(token) }]) {
    await assert.rejects(measureRoomAvailability({ ...options, ...patch }), /LOAD_AVAILABILITY_INVALID/);
  }
  await assert.rejects(measureRoomAvailability({ ...options, origin: 'https://example.com' }), /LOAD_DESTINATION_INVALID/);
  await assert.rejects(measureRoomAvailability({ ...options, cookies: ['bad'] }), /LOAD_COOKIES_INVALID/);
  await assert.rejects(measureRoomAvailability({ ...options, concurrency: 33 }), /LOAD_BOUNDS_INVALID/);
});

test('availability load fixes POST path/payload/CSRF and counts exact wire bytes; failures never retry or publish', async () => {
  let failure; let calls = 0; let inputBytes = 0;
  const output = JSON.stringify({ schemaVersion: 1, availability: { available: true, conflictCount: 0 } });
  const server = createServer(async (req, res) => {
    calls += 1; assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/v1/application/room-availability');
    assert.equal(req.headers.cookie, cookie); assert.equal(req.headers['x-csrf-token'], token);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); inputBytes += bytes.length;
    assert.deepEqual(JSON.parse(bytes), { roomId: 'room', ...slot });
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
    if (failure === 'redirect') { res.writeHead(302, { Location: 'http://example.com' }); res.end(); return; }
    res.writeHead(failure === 'status' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(failure === 'large' ? 'x'.repeat(8193) : failure === 'json' ? '{' : output);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await measureRoomAvailability({ ...options, origin: `http://127.0.0.1:${server.address().port}`,
      verify(body) { assert.deepEqual(body, JSON.parse(output)); } });
    assert.equal(result.requests, 1); assert.equal(result.payloadBytes, Buffer.byteLength(output));
    assert.equal(result.requestPayloadBytes, inputBytes);
    for (failure of ['redirect', 'status', 'large', 'json']) {
      const before = calls;
      await assert.rejects(measureRoomAvailability({ ...options, origin: `http://127.0.0.1:${server.address().port}` }),
        /LOAD_ACCEPTANCE_FAILED/);
      assert.equal(calls, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
