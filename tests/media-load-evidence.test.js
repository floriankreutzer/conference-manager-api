import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { measureRoomMediaReads } from '../scripts/session-load-evidence.mjs';

const asset = '11111111-1111-4111-8111-111111111111';
const cookie = `cm_session=${'a'.repeat(43)}`;
const etag = `"${'b'.repeat(64)}"`;
const options = { origin: 'http://127.0.0.1:1', cookies: [cookie], assetIds: [asset], verify() {} };

test('media measurement refuses invalid identifiers, headers, batches and destinations', async () => {
  for (const patch of [{ assetIds: ['../secret'] }, { assetIds: ['-'.repeat(36)] }, { assetIds: [] },
    { etags: [] }, { etags: ['*'] }, { etags: [etag + '\r\nInjected: true'] },
    { cookies: Array(1001).fill(cookie), assetIds: Array(1001).fill(asset) }]) {
    await assert.rejects(measureRoomMediaReads({ ...options, ...patch }), /LOAD_MEDIA_INPUT_INVALID/);
  }
  await assert.rejects(measureRoomMediaReads({ ...options, origin: 'https://example.com' }), /LOAD_DESTINATION_INVALID/);
  await assert.rejects(measureRoomMediaReads({ ...options, cookies: ['bad'] }), /LOAD_COOKIES_INVALID/);
});

test('media measurement verifies binary/private-cache contracts and never retries failed reads', async () => {
  const bytes = Buffer.alloc(16384, 123);
  let failure; let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/api/v1/tenant/rooms/room/media/${asset}`);
    assert.equal(request.headers.cookie, cookie);
    if (failure === 'redirect') { response.writeHead(302, { Location: 'https://example.com' }); response.end(); return; }
    const conditional = request.headers['if-none-match'] !== undefined;
    if (conditional) assert.equal(request.headers['if-none-match'], etag);
    response.setHeader('ETag', failure === 'etag' ? '*' : etag);
    response.setHeader('Vary', 'Cookie');
    response.setHeader('Cache-Control', failure === 'cache' ? 'public' : 'private, no-cache, max-age=0, must-revalidate');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.statusCode = failure === 'status' ? 503 : conditional ? 304 : 200;
    if (!conditional) response.setHeader('Content-Type', failure === 'type' ? 'text/html' : 'image/webp');
    response.end(conditional ? undefined : failure === 'large' ? Buffer.alloc(2097153) : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const full = await measureRoomMediaReads({ ...options, origin, verify(body, index, metadata) {
      assert.deepEqual(body, bytes); assert.equal(index, 0); assert.deepEqual(metadata, { etag, status: 200 });
    } });
    assert.equal(full.payloadBytes, bytes.length);
    const reused = await measureRoomMediaReads({ ...options, origin, etags: [etag], verify(body, index, metadata) {
      assert.equal(body.length, 0); assert.equal(index, 0); assert.deepEqual(metadata, { etag, status: 304 });
    } });
    assert.equal(reused.payloadBytes, 0);
    for (failure of ['redirect', 'etag', 'cache', 'status', 'type', 'large']) {
      const before = calls;
      await assert.rejects(measureRoomMediaReads({ ...options, origin }), /LOAD_ACCEPTANCE_FAILED/);
      assert.equal(calls, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
