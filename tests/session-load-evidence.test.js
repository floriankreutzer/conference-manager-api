import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { measureSessionReads, measureCatalogRoomReads, measureRequestCreates } from '../scripts/session-load-evidence.mjs';
import { requestLoadDraft } from './support/request-load-draft.js';
import { seedLoadSessions } from '../tests-db/support/customer-load-fixtures.js';
import { createSessionLoadRuntime } from '../scripts/support/session-load-runtime.mjs';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { tenantAuthorizationSnapshot, TENANT_ROLE } from '../src/authorization/policy.js';

const cookie = `cm_session=${'a'.repeat(43)}`;
const csrfToken = 'c'.repeat(43);

test('create measurement validates bounded canonical input and fixture roles before any I/O', async () => {
  const base = { origin: 'http://127.0.0.1:1234', cookies: [cookie], drafts: [requestLoadDraft()],
    csrfTokens: [csrfToken], verify() {} };
  for (const patch of [{ cookies: [] }, { cookies: Array(1001).fill(cookie) }, { drafts: [] }, { csrfTokens: [] },
    { csrfTokens: ['private\r\nheader'] }, { drafts: [{ ...requestLoadDraft(), tenantId: 'foreign' }] },
    { drafts: [{ ...requestLoadDraft(), specialRequirements: 'a'.repeat(2001) }] },
    { drafts: [{ ...requestLoadDraft(), dietaryRequirements: 'ä'.repeat(2000), specialRequirements: 'ä'.repeat(2000) }] }]) {
    await assert.rejects(measureRequestCreates({ ...base, ...patch }), /^Error: LOAD_WRITE_INPUT_INVALID$/);
  }
  for (const origin of ['http://example.com:1234', 'http://127.0.0.1:1234/other', 'https://127.0.0.1:1234']) {
    await assert.rejects(measureRequestCreates({ ...base, origin }), /LOAD_DESTINATION_INVALID/);
  }
  for (const patch of [{ concurrency: 33 }, { deadlineMs: 60_001 }, { onFailure: 'private' }, { cookies: [`${cookie}; secret=x`] }]) {
    await assert.rejects(measureRequestCreates({ ...base, ...patch }), /LOAD_(BOUNDS|COOKIES)_INVALID/);
  }
  for (const roles of [[], ['unknown'], ['employee', 'employee']]) {
    await assert.rejects(seedLoadSessions({}, [], [], 1, { roles }), /LOAD_FIXTURE_ROLES_INVALID/);
  }
});

test('create measurement fixes POST, origin, CSRF and schema and counts both payload directions without retries', async () => {
  let mode = 'valid'; let requests = 0; let sentBytes = 0;
  const responseBody = JSON.stringify({ created: 'synthetic' });
  const server = createServer(async (req, res) => {
    requests += 1;
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/v1/application/requests');
    assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
    assert.equal(req.headers['x-csrf-token'], csrfToken); assert.equal(req.headers.cookie, cookie);
    assert.equal(req.headers['content-type'], 'application/json');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = Buffer.concat(chunks); sentBytes += input.length;
    assert.equal(input.length, Number(req.headers['content-length']));
    assert.deepEqual(JSON.parse(input), { schemaVersion: 3, request: requestLoadDraft() });
    if (mode === 'stall') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end(); return; }
    res.statusCode = mode === 'wrong-status' ? 200 : 201;
    res.end(mode === 'oversize' ? 'a'.repeat(8193) : mode === 'malformed' ? 'private' : responseBody);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { origin: `http://127.0.0.1:${server.address().port}`, cookies: [cookie],
      drafts: [requestLoadDraft()], csrfTokens: [csrfToken], deadlineMs: 100,
      verify(body) { assert.equal(body.created, 'synthetic'); } };
    const result = await measureRequestCreates({ ...base, deadlineMs: 5000 });
    assert.equal(result.requests, 1); assert.equal(result.payloadBytes, Buffer.byteLength(responseBody));
    assert.equal(result.requestPayloadBytes, sentBytes);
    for (const failure of ['redirect', 'wrong-status', 'oversize', 'malformed', 'stall', 'identity']) {
      mode = failure;
      const before = requests; const diagnostics = [];
      await assert.rejects(measureRequestCreates({ ...base, onFailure(value) { diagnostics.push(value); }, ...(mode === 'identity' ? {
        verify() { throw new Error('PRIVATE_VERIFIER_DETAILS'); },
      } : {}) }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
      assert.equal(requests, before + 1, 'Writes must never retry or follow redirects');
      assert.equal(diagnostics.length, 1); assert.ok(Object.isFrozen(diagnostics[0]));
      const { elapsedMs, ...diagnostic } = diagnostics[0]; assert.ok(elapsedMs >= 0);
      const stage = { redirect: 'response-status', 'wrong-status': 'response-status', oversize: 'response-body',
        malformed: 'response-json', stall: 'transport', identity: 'verify' }[failure];
      assert.deepEqual(diagnostic, { index: 0, requests: 1, concurrency: 16, arrivalIntervalMs: 0, completed: 0,
        stage, status: failure === 'stall' ? null : failure === 'redirect' ? 302 : failure === 'wrong-status' ? 200 : 201,
        deadlineReached: failure === 'stall' });
      assert.equal(JSON.stringify(diagnostics).includes('PRIVATE'), false);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('full session-load composition serves canonical HTTP with controlled repository ports and no provider or DB connection', async () => {
  const config = { ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/conference_manager_test_1_1',
    ENTRA_CLIENT_ID: randomUUID(), ENTRA_CLIENT_SECRET: randomBytes(32).toString('hex'),
    OIDC_TRANSACTION_SECRET: randomBytes(32).toString('hex'),
    AUDIT_HMAC_SECRET: randomBytes(32).toString('hex'), CSRF_SECRET: randomBytes(32).toString('hex') }), port: 0 };
  const persistence = createPostgresPersistence(config);
  const tenantId = randomUUID(); const userId = randomUUID();
  const at = new Date().toISOString();
  let session;
  const runtime = createSessionLoadRuntime({ config, persistence: { ...persistence,
    sessionRepository: { ...persistence.sessionRepository,
      async issue(record) { session = { ...record, securityVersion: 1 }; return session; },
      async resolveByTokenHash(hash) { assert.equal(hash, session.tokenHash); return session; } },
    async loadTenant(id) { assert.equal(id, tenantId); return { id, status: 'active', displayName: 'Synthetic load fixture',
      createdAt: at, updatedAt: at }; } } });
  try {
    const address = await runtime.start();
    config.publicOrigin = `http://127.0.0.1:${address.port}`;
    const issued = await runtime.sessionService.issue({ tenantId, userId, securityVersion: 1,
      providerIdentity: { provider: 'microsoft_entra', reference: 'synthetic' },
      ...tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE]) });
    const result = await measureSessionReads({ origin: config.publicOrigin,
      cookies: [issued.setCookie.split(';', 1)[0]], verify(body) {
        assert.equal(body.user.id, userId); assert.equal(body.tenant.id, tenantId);
      } });
    assert.equal(result.requests, 1); assert.equal(persistence.pool.totalCount, 0);
  }
  finally { await runtime.stop(); }
});

test('room-page measurement fixes the route and page size, bounds context and rejects foreign data', async () => {
  const base = { origin: 'http://127.0.0.1:1234', cookies: [cookie], verify() {} };
  for (const context of [undefined, '', 'a'.repeat(2049), 'safe&section=sites', 'https://example.com']) {
    await assert.rejects(measureCatalogRoomReads({ ...base, context }), /LOAD_CONTEXT_INVALID/);
  }
  let requests = 0;
  let redirect = false;
  const payload = JSON.stringify({ entries: [{ name: 'Synthetic owned room' }] });
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/v1/application/catalog?section=rooms&limit=5&context=bounded');
    if (redirect) { res.writeHead(302, { Location: 'https://example.com/private' }); res.end(); }
    else res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { ...base, origin: `http://127.0.0.1:${server.address().port}`, context: 'bounded' };
    const result = await measureCatalogRoomReads({ ...options, cookies: Array(100).fill(cookie),
      verify(body) { assert.equal(body.entries[0].name, 'Synthetic owned room'); } });
    assert.equal(result.requests, 100);
    assert.equal(result.payloadBytes, 100 * Buffer.byteLength(payload));
    await assert.rejects(measureCatalogRoomReads({ ...options,
      verify(body) { assert.equal(body.entries[0].name, 'Synthetic foreign room'); } }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
    assert.equal(requests, 101);
    redirect = true;
    await assert.rejects(measureCatalogRoomReads(options), /^Error: LOAD_ACCEPTANCE_FAILED$/);
    assert.equal(requests, 102);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('room continuation measurement accepts only a bounded cursor and preserves response verification', async () => {
  const base = { origin: 'http://127.0.0.1:1234', cookies: [cookie], verify() {} };
  for (const cursor of ['', null, 'a'.repeat(2049), 'safe&section=sites', 'https://example.com']) {
    await assert.rejects(measureCatalogRoomReads({ ...base, cursor }), /LOAD_CURSOR_INVALID/);
  }
  await assert.rejects(measureCatalogRoomReads({ ...base, context: 'bounded', cursor: 'continuation' }), /LOAD_CURSOR_INVALID/);
  let requests = 0;
  const payload = JSON.stringify({ entries: [{ name: 'Synthetic final room' }], page: { complete: true, nextCursor: null } });
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/v1/application/catalog?section=rooms&limit=5&cursor=continuation');
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { ...base, origin: `http://127.0.0.1:${server.address().port}`, cursor: 'continuation' };
    const result = await measureCatalogRoomReads({ ...options, cookies: Array(100).fill(cookie), verify(body) {
      assert.equal(body.entries[0].name, 'Synthetic final room');
      assert.deepEqual(body.page, { complete: true, nextCursor: null });
    } });
    assert.equal(result.requests, 100);
    assert.equal(result.payloadBytes, 100 * Buffer.byteLength(payload));
    await assert.rejects(measureCatalogRoomReads({ ...options, verify(body) {
      assert.equal(body.entries[0].name, 'Synthetic foreign room');
    } }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
    assert.equal(requests, 101);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

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
    for (const measure of [measureSessionReads, (options) => measureCatalogRoomReads({ context: 'bounded', ...options }),
      (options) => measureCatalogRoomReads({ cursor: 'continuation', ...options })]) {
      for (const nextMode of ['stall', 'oversize', 'malformed', 'identity']) {
        mode = nextMode;
        await assert.rejects(measure({ ...base,
          verify(body) { assert.equal(body.tenant, 'owned'); } }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
      }
    }
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});


test('fixed arrivals retain backlog latency, exact read/write protocols and the unpaced result contract', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests += 1;
    assert.equal(req.headers.cookie, cookie);
    if (req.method === 'POST') {
      assert.equal(req.url, '/api/v1/application/requests');
      assert.equal(req.headers['x-csrf-token'], csrfToken);
      assert.equal(req.headers.origin, `http://127.0.0.1:${server.address().port}`);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), { schemaVersion: 3, request: requestLoadDraft() });
      res.statusCode = 201;
    } else { assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/v1/session'); }
    await new Promise(resolve => setTimeout(resolve, 30));
    res.end('{"synthetic":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { origin: `http://127.0.0.1:${server.address().port}`, cookies: Array(6).fill(cookie),
      concurrency: 1, arrivalIntervalMs: 5, verify(body) { assert.deepEqual(body, { synthetic: true }); } };
    for (const measure of [measureSessionReads, options => measureRequestCreates({ ...options,
      drafts: Array(6).fill(requestLoadDraft()), csrfTokens: Array(6).fill(csrfToken) })]) {
      const before = requests;
      const result = await measure(base);
      assert.equal(requests - before, 6); assert.equal(result.requests, 6);
      assert.equal(result.arrivalIntervalMs, 5); assert.equal(result.offeredRequestsPerSecond, 200);
      assert.ok(result.scheduleLagMs.p95 > 80, 'Backlog must not reset the original arrival schedule');
      assert.ok(result.scheduledLatencyMs.p95 > result.latencyMs.p95 + 80);
    }
    const paced = await measureSessionReads({ ...base, concurrency: 3, arrivalIntervalMs: 40,
      cookies: [cookie, cookie, cookie] });
    assert.equal(paced.requests, 3); assert.ok(paced.elapsedMs >= 80, 'Future arrivals must wait for their planned time');
    const result = await measureSessionReads({ ...base, arrivalIntervalMs: 0, cookies: [cookie] });
    for (const key of ['arrivalIntervalMs', 'offeredRequestsPerSecond', 'scheduledLatencyMs', 'scheduleLagMs']) {
      assert.equal(key in result, false, 'Unpaced result shape must stay compatible');
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('invalid arrival bounds fail before I/O and a deadline abort drains scheduled workers without later sends', async () => {
  let requests = 0;
  const server = createServer((req, res) => { requests += 1; if (requests > 1) res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = { origin: `http://127.0.0.1:${server.address().port}`, cookies: [cookie, cookie, cookie],
      deadlineMs: 150, verify() {} };
    for (const arrivalIntervalMs of [-1, 0.5, NaN, Infinity, '5', 1001, 75]) {
      await assert.rejects(measureSessionReads({ ...base, arrivalIntervalMs }), /^Error: LOAD_ARRIVAL_INVALID$/);
    }
    assert.equal(requests, 0);
    await assert.rejects(measureSessionReads({ ...base, concurrency: 1, arrivalIntervalMs: 60 }),
      /^Error: LOAD_ACCEPTANCE_FAILED$/);
    assert.equal(requests, 1, 'An aborted backlog must not dispatch its remaining writes or reads');
    // A verification failure aborts other workers while their future arrival timers are pending.
    requests = 1;
    await assert.rejects(measureSessionReads({ ...base, concurrency: 3, arrivalIntervalMs: 60,
      verify() { throw new Error('PRIVATE_VERIFIER_DETAILS'); } }), /^Error: LOAD_ACCEPTANCE_FAILED$/);
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(requests, 2, 'Cancelled arrival timers must not send later requests');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
