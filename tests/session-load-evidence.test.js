import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { measureSessionReads } from '../scripts/session-load-evidence.mjs';

const cookie = `cm_session=${'a'.repeat(43)}`;
test('load measurement accepts only bounded loopback session reads and never follows redirects', async () => {
  for (const origin of ['https://127.0.0.1:1234', 'http://localhost:1234', 'http://example.com:1234',
    'http://127.0.0.1:1234/other', 'http://user:password@127.0.0.1:1234', 'http://127.0.0.1:1234/?token=secret']) {
    await assert.rejects(measureSessionReads({ origin, cookies: [cookie], verify() {} }), /LOAD_DESTINATION_INVALID/);
  }
  const base = { origin: 'http://127.0.0.1:1234', cookies: [cookie], verify() {} };
  for (const values of [{ cookies: [] }, { cookies: [`${cookie}; private=value`] },
    { cookies: Array(10_001).fill(cookie) }, { concurrency: 33 }, { deadlineMs: 60_001 }]) {
    await assert.rejects(measureSessionReads({ ...base, ...values }), /LOAD_(COOKIES|BOUNDS)_INVALID/);
  }
  let requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/v1/session'); assert.equal(req.method, 'GET');
    requests += 1;
    if (requests > 100) { res.writeHead(302, { Location: 'https://example.com/private' }); res.end(); }
    else res.end(JSON.stringify({ status: 'synthetic' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const result = await measureSessionReads({ origin, cookies: Array(100).fill(cookie),
      verify(body) { assert.equal(body.status, 'synthetic'); } });
    assert.equal(result.requests, 100); assert.equal(requests, 100);
    assert.equal(result.payloadBytes, 100 * Buffer.byteLength(JSON.stringify({ status: 'synthetic' })));
    assert.ok(result.latencyMs.p99 >= result.latencyMs.p50);
    await assert.rejects(measureSessionReads({ origin, cookies: [cookie], verify() {} }), /LOAD_ACCEPTANCE_FAILED/);
    assert.equal(requests, 101);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('load measurement rejects incomplete, oversized, malformed and identity-invalid results', async () => {
  let mode = 'stall';
  const server = createServer((req, res) => {
    if (mode === 'stall') return;
    if (mode === 'oversize') res.end('a'.repeat(8_193));
    else if (mode === 'malformed') res.end('private malformed data');
    else res.end(JSON.stringify({ tenant: 'foreign' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { origin: `http://127.0.0.1:${server.address().port}`, cookies: [cookie],
      deadlineMs: 100, verify() {} };
    for (const nextMode of ['stall', 'oversize', 'malformed', 'identity']) {
      mode = nextMode;
      await assert.rejects(measureSessionReads({ ...base,
        verify(body) { assert.equal(body.tenant, 'owned'); } }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
    }
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
