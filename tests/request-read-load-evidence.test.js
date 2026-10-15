import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { measureRequestReads } from '../scripts/session-load-evidence.mjs';

const cookie = 'cm_session=' + 'a'.repeat(43);
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];

test('Request read measurement rejects unbounded or route-selecting identifiers before I/O', async () => {
  const base = { origin: 'http://127.0.0.1:1', cookies: [cookie], requestIds: [ids[0]], verify() {} };
  for (const requestIds of [undefined, [], ['../session'], [ids[0] + '?private=value'],
    ['https://example.com'], ['a'.repeat(129)], [null], [ids[0], ids[1]]]) {
    await assert.rejects(measureRequestReads({ ...base, requestIds }), /^Error: LOAD_READ_INPUT_INVALID$/);
  }
  for (const cookies of [[], Array(1001).fill(cookie)]) {
    await assert.rejects(measureRequestReads({ ...base, cookies,
      requestIds: cookies.map(() => ids[0]) }), /^Error: LOAD_READ_INPUT_INVALID$/);
  }
  await assert.rejects(measureRequestReads({ ...base, origin: 'https://example.com' }), /LOAD_DESTINATION_INVALID/);
  await assert.rejects(measureRequestReads({ ...base, cookies: [cookie + '; private=x'] }), /LOAD_COOKIES_INVALID/);
});

test('Request read measurement binds each response to its ID and retains bounded GET failure semantics', async () => {
  let requests = 0; let mode = 'valid';
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET'); assert.equal(req.headers.cookie, cookie);
    assert.equal(req.headers['x-csrf-token'], undefined);
    const id = req.url.slice('/api/v1/requests/'.length);
    assert.ok(ids.includes(id)); assert.equal(req.url, '/api/v1/requests/' + id);
    if (mode === 'stall') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return; }
    res.statusCode = mode === 'denied' ? 404 : 200;
    res.end(mode === 'oversize' ? 'x'.repeat(8193) : mode === 'malformed' ? 'private payload'
      : JSON.stringify({ request: { id: mode === 'foreign' ? 'foreign' : id } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { origin: 'http://127.0.0.1:' + server.address().port, cookies: [cookie, cookie],
      requestIds: ids, verify(body, index) { assert.equal(body.request.id, ids[index]); } };
    const result = await measureRequestReads(options);
    assert.equal(result.requests, 2); assert.equal(requests, 2);
    assert.equal(result.payloadBytes, ids.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify({ request: { id } })), 0));
    assert.equal('requestPayloadBytes' in result, false);
    for (const failure of ['redirect', 'denied', 'oversize', 'malformed', 'foreign', 'stall']) {
      mode = failure; const before = requests;
      await assert.rejects(measureRequestReads({ ...options, cookies: [cookie], requestIds: [ids[0]],
        deadlineMs: failure === 'stall' ? 100 : 5000 }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
      assert.equal(requests, before + 1, 'No redirects, retries or successful partial aggregate');
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
