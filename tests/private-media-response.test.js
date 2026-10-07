import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRoomMediaHttpHandler } from '../src/http/room-media.js';
import { sendPrivateMediaResponse } from '../src/http/private-media-response.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const bytes = Buffer.from('verified webp bytes');

function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(body) { this.body = body; } };
}

function send(header, overrides = {}) {
  const output = response();
  const status = sendPrivateMediaResponse({ request: { headers: { 'if-none-match': header } },
    response: output, tenantId, assetId, bytes, contentType: 'image/webp', ...overrides });
  return { output, status };
}

test('private media returns an opaque strong validator and requires authorization revalidation on every reuse', () => {
  const first = send();
  assert.equal(first.status, 200);
  assert.deepEqual(first.output.body, bytes);
  assert.match(first.output.headers.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(first.output.headers['cache-control'], 'private, no-cache, max-age=0, must-revalidate');
  assert.equal(first.output.headers.vary, 'Cookie');
  for (const header of [first.output.headers.etag, `W/${first.output.headers.etag}`,
    `"old", ${first.output.headers.etag}`, '*']) {
    const cached = send(header);
    assert.equal(cached.status, 304);
    assert.equal(cached.output.body, undefined);
    assert.equal(cached.output.headers['content-length'], undefined);
    assert.equal(cached.output.headers['content-type'], undefined);
  }
});

test('Tenant, asset, type and content changes invalidate a previously cached media response', () => {
  const etag = send().output.headers.etag;
  for (const change of [{ tenantId: '33333333-3333-4333-8333-333333333333' },
    { assetId: '44444444-4444-4444-8444-444444444444' }, { contentType: 'image/png' },
    { bytes: Buffer.from('replacement bytes') }]) {
    const changed = send(etag, change);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.output.headers.etag, etag);
  }
});

test('malformed, oversized and excessive conditional headers cannot suppress authorized delivery', () => {
  const etag = send().output.headers.etag;
  for (const header of [[etag], `${etag}, malformed`, `* , ${etag}`, 'x'.repeat(8193),
    Array(33).fill(etag).join(','), `${etag}\r\nInjected: true`]) assert.equal(send(header).status, 200);
  for (const invalid of [{ bytes: Buffer.alloc(0) }, { bytes: Buffer.alloc(2097153) },
    { bytes: 'unverified' }, { contentType: 'text/html' }]) {
    assert.throws(() => send(etag, invalid), /PRIVATE_MEDIA_RESPONSE_INVALID/);
  }
});

test('Room conditional GET rechecks authority; revoked sessions and missing/foreign assets never return 304', async () => {
  const calls = [];
  let allowed = true;
  let available = true;
  const handler = createRoomMediaHttpHandler({
    principalGuard: { async require() { calls.push('session'); if (!allowed) throw new Error('SESSION_REVOKED'); return {}; } },
    tenantGuard: { async requireKnown() { calls.push('tenant'); return { tenantId }; } },
    service: { async read(input) { calls.push('attachment'); assert.equal(input.tenantContext.tenantId, tenantId);
      return available ? { bytes, contentType: 'image/webp' } : null; } },
  });
  async function read(header) {
    const request = Readable.from([]);
    request.method = 'GET'; request.headers = { 'if-none-match': header };
    const path = `/api/v1/tenant/rooms/room-one/media/${assetId}`;
    const output = response();
    const status = await handler({ request, response: output, path, parsedUrl: new URL(path, 'https://customer.test') });
    return { status, output };
  }
  const etag = (await read()).output.headers.etag;
  assert.equal((await read(etag)).status, 304);
  assert.deepEqual(calls, ['session', 'tenant', 'attachment', 'session', 'tenant', 'attachment']);
  available = false;
  await assert.rejects(read(etag), { code: 'NOT_FOUND' });
  allowed = false;
  await assert.rejects(read('*'), /SESSION_REVOKED/);
  assert.equal(calls.at(-1), 'session');
});
