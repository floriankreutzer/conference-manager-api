import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { measureRequestTransitions } from '../scripts/session-load-evidence.mjs';

const cookie = `cm_session=${'a'.repeat(43)}`;
const token = 'c'.repeat(43);

test('transition load confines target, phase, IDs, credentials and resource bounds before I/O', async () => {
  const id = randomUUID();
  const base = { origin: 'http://127.0.0.1:1', cookies: [cookie], csrfTokens: [token],
    requestIds: [id], transition: 'start_review', verify() {} };
  for (const patch of [{ transition: 'confirm' }, { transition: 'cancel' }, { transition: 'unknown' },
    { requestIds: [] }, { requestIds: ['../../secret'] }, { csrfTokens: [] }, { csrfTokens: ['private\r\nheader'] },
    { cookies: Array(1001).fill(cookie) }, { cookies: [cookie, cookie], requestIds: [id, id], csrfTokens: [token, token] }]) {
    await assert.rejects(measureRequestTransitions({ ...base, ...patch }), /^Error: LOAD_TRANSITION_INPUT_INVALID$/);
  }
  for (const origin of ['https://127.0.0.1:1', 'http://example.com:1', 'http://127.0.0.1:1/other']) {
    await assert.rejects(measureRequestTransitions({ ...base, origin }), /LOAD_DESTINATION_INVALID/);
  }
  await assert.rejects(measureRequestTransitions({ ...base, concurrency: 33 }), /LOAD_BOUNDS_INVALID/);
});

test('transition load fixes manager commands, strong versions and successful response accounting without retries', async () => {
  let phase = 'start_review'; let failure = null; let requests = 0; let bytes = 0;
  const id = randomUUID(); const responseBody = JSON.stringify({ request: { id } });
  const server = createServer(async (req, res) => {
    requests += 1;
    assert.equal(req.method, 'POST'); assert.equal(req.url, `/api/v1/requests/${id}/transitions`);
    assert.equal(req.headers['if-match'], phase === 'start_review' ? '"1"' : '"2"');
    assert.equal(req.headers['x-csrf-token'], token); assert.equal(req.headers.cookie, cookie);
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); bytes += body.length;
    assert.equal(body.length, Number(req.headers['content-length']));
    assert.deepEqual(JSON.parse(body), phase === 'start_review'
      ? { transition: phase } : { transition: phase, reason: 'Synthetic isolated load decision' });
    if (failure === 'stall') return;
    if (failure === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return; }
    res.statusCode = failure === 'status' ? 201 : 200;
    res.end(failure === 'oversize' ? 'a'.repeat(8193) : failure === 'malformed' ? 'private' : responseBody);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { origin: `http://127.0.0.1:${server.address().port}`, cookies: [cookie],
      csrfTokens: [token], requestIds: [id], deadlineMs: 100,
      verify(body) { assert.equal(body.request.id, id); } };
    for (phase of ['start_review', 'reject']) {
      const before = bytes;
      const result = await measureRequestTransitions({ ...base, transition: phase, deadlineMs: 5000 });
      assert.equal(result.requests, 1); assert.equal(result.payloadBytes, Buffer.byteLength(responseBody));
      assert.equal(result.requestPayloadBytes, bytes - before);
    }
    for (failure of ['status', 'redirect', 'oversize', 'malformed', 'stall', 'identity']) {
      const before = requests;
      await assert.rejects(measureRequestTransitions({ ...base, transition: phase,
        ...(failure === 'identity' ? { verify() { throw new Error('PRIVATE_DETAILS'); } } : {}) }),
      /^Error: LOAD_ACCEPTANCE_FAILED$/);
      assert.equal(requests, before + 1);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
