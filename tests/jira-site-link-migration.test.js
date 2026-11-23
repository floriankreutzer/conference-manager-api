import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateJiraSiteLinks } from '../scripts/jira-site-link-migration.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const config = { cloudId: '00000000-0000-0000-0000-000000000001', email: 'test@example.invalid',
  token: 'test-only-jira-token', accountId: 'test-account', sourceHostHash: hash('old-test.atlassian.net'),
  targetHostHash: hash('new-test.atlassian.net'), links: 'CO-361:10001,KNMCP-26:10002', mode: 'preview' };
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture() {
  const calls = [];
  const links = new Map(['10001', '10002'].map((id) => [id, { id: Number(id),
    self: `https://new-test.atlassian.net/rest/api/3/issue/CO-361/remotelink/${id}`,
    globalId: 'opaque-reference', application: { type: 'example', name: 'Keep application' },
    relationship: 'governed by', object: { title: 'Private title', summary: 'Private summary',
      url: `https://old-test.atlassian.net/wiki/a%2Fb?q=%20#Section+1`,
      icon: { title: 'Keep icon', url16x16: 'https://example.invalid/icon' },
      status: { resolved: true, icon: { title: 'Keep status', link: 'https://example.invalid/status' } } } }]));
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).origin, 'https://api.atlassian.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`);
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith('/myself')) return response({ accountId: config.accountId, active: true });
    if (url.endsWith('/serverInfo')) return response({ baseUrl: 'https://new-test.atlassian.net' });
    const match = /\/issue\/(?:CO-361|KNMCP-26)\/remotelink\/(10001|10002)$/.exec(url);
    assert.ok(match, 'Only exact approved paths are requested');
    const id = match[1];
    if (init.method === 'PUT') {
      links.set(id, { ...links.get(id), ...JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    assert.equal(init.method, 'GET');
    return response(links.get(id));
  };
  return { calls, links, fetchImpl };
}
async function run(f, overrides = {}) {
  const lines = [];
  const code = await migrateJiraSiteLinks({ ...config, fetchImpl: f.fetchImpl, ...overrides, write: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  for (const secret of [config.email, config.token, config.cloudId, config.accountId, 'Private', 'old-test.atlassian.net',
    'new-test.atlassian.net', 'opaque-reference']) assert.equal(lines[0].includes(secret), false);
  return { code, ...JSON.parse(lines[0]) };
}

test('preview is read-only; apply preserves IDs, opaque metadata and exact URL suffix bytes', async () => {
  const f = fixture();
  const originals = structuredClone(f.links);
  const preview = await run(f);
  assert.equal(preview.code, 0);
  assert.equal(preview.proposed, 2);
  assert.equal(preview.mutationPerformed, false);
  assert.equal(f.calls.some((call) => call.init.method !== 'GET'), false);
  const applied = await run(f, { mode: 'apply', planDigest: preview.planDigest });
  assert.equal(applied.result, 'JIRA_LINK_MIGRATION_VERIFIED');
  assert.equal(applied.verified, 2);
  for (const [id, original] of originals) {
    original.object.url = original.object.url.replace('old-test.atlassian.net', 'new-test.atlassian.net');
    assert.deepEqual(f.links.get(id), original);
  }
  assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 2);
  const again = await run(f);
  assert.equal(again.alreadyCurrent, 2);
  assert.equal(again.proposed, 0);
  const repeated = await run(f, { mode: 'apply', planDigest: again.planDigest });
  assert.equal(repeated.verified, 0);
  assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 2);
});

for (const invalid of [
  { links: '' }, { links: 'CO-361:10001,CO-361:10001' }, { links: 'OTHER-1:10001' },
  { links: 'CO-361/../../myself:10001' }, { links: Array.from({ length: 101 }, (_, i) => `CO-1:${i + 1}`).join(',') },
  { sourceHostHash: config.targetHostHash }, { targetHostHash: 'bad' }, { cloudId: '../other' },
  { email: 'x\n@example.invalid' }, { token: 'short' }, { accountId: '' }, { mode: 'apply' }, { mode: 'delete' },
]) {
  test(`invalid configuration is rejected before I/O: ${Object.keys(invalid).join()}`, async () => {
    const f = fixture();
    assert.equal((await run(f, invalid)).reason, 'CONFIGURATION');
    assert.equal(f.calls.length, 0);
  });
}

test('wrong actor, disabled actor or mismatched target site cannot write', async () => {
  for (const [path, value] of [['/myself', { accountId: 'other', active: true }],
    ['/myself', { accountId: config.accountId, active: false }],
    ['/serverInfo', { baseUrl: 'https://foreign-test.atlassian.net' }]]) {
    const f = fixture();
    const original = f.fetchImpl;
    f.fetchImpl = (url, init) => url.endsWith(path) ? response(value) : original(url, init);
    assert.equal((await run(f)).code, 1);
    assert.equal(f.calls.some((call) => call.init.method === 'PUT'), false);
  }
});

test('unsupported schema, wrong link identity, foreign hosts and credential URLs fail closed', async () => {
  for (const mutate of [(x) => { x.extra = 'preserve me'; }, (x) => { x.id = 111; },
    (x) => { x.object.url = 'https://foreign-test.atlassian.net/wiki/1'; },
    (x) => { x.object.url = 'http://old-test.atlassian.net/wiki/1'; },
    (x) => { x.object.url = 'https://user:password@old-test.atlassian.net/wiki/1'; },
    (x) => { x.object.url = 'https://old-test.atlassian.net.evil.invalid/wiki/1'; },
    (x) => { x.object.url = 'https://old-test.atlassian.net:444/wiki/1'; },
    (x) => { x.object.title = null; }]) {
    const f = fixture(); mutate(f.links.get('10001'));
    assert.equal((await run(f)).code, 1);
    assert.equal(f.calls.some((call) => call.init.method === 'PUT'), false);
  }
});

test('stale preview digest blocks all writes, including changed metadata or changed manifest', async () => {
  const f = fixture(); const preview = await run(f);
  f.links.get('10002').relationship = 'changed';
  assert.equal((await run(f, { mode: 'apply', planDigest: preview.planDigest })).reason, 'PLAN_CHANGED');
  assert.equal((await run(f, { mode: 'apply', planDigest: preview.planDigest, links: 'CO-361:10001' })).reason, 'PLAN_CHANGED');
  assert.equal(f.calls.some((call) => call.init.method === 'PUT'), false);
});

test('immediate recheck detects a concurrent edit before the first PUT', async () => {
  const f = fixture(); const preview = await run(f); const original = f.fetchImpl;
  let linkReads = 0;
  f.fetchImpl = (url, init) => {
    if (url.includes('/remotelink/') && init.method === 'GET' && ++linkReads === 3) f.links.get('10001').object.summary = 'Changed';
    return original(url, init);
  };
  assert.equal((await run(f, { mode: 'apply', planDigest: preview.planDigest })).reason, 'CONCURRENT_CHANGE');
  assert.equal(f.calls.some((call) => call.init.method === 'PUT'), false);
});

test('uncertain write stops without replay; a new preview safely recovers an already applied update', async () => {
  const f = fixture(); const preview = await run(f); const original = f.fetchImpl;
  f.fetchImpl = async (url, init) => {
    const result = await original(url, init);
    if (init.method === 'PUT') throw new Error(config.token);
    return result;
  };
  const failed = await run(f, { mode: 'apply', planDigest: preview.planDigest });
  assert.equal(failed.writeMayHaveCommitted, true);
  assert.equal(failed.verified, 0);
  assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1);
  f.fetchImpl = original;
  const recovery = await run(f);
  assert.equal(recovery.alreadyCurrent, 1);
  assert.equal((await run(f, { mode: 'apply', planDigest: recovery.planDigest })).verified, 1);
});

test('readback mismatch is never success; no later links are written', async () => {
  const f = fixture(); const preview = await run(f); const original = f.fetchImpl;
  f.fetchImpl = async (url, init) => {
    const result = await original(url, init);
    if (init.method === 'PUT') f.links.get('10001').object.title = 'Unexpected edit';
    return result;
  };
  assert.equal((await run(f, { mode: 'apply', planDigest: preview.planDigest })).reason, 'READBACK');
  assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1);
});

test('a later write failure retains the verified partial count and never retries', async () => {
  const f = fixture(); const preview = await run(f); const original = f.fetchImpl;
  let writes = 0;
  f.fetchImpl = (url, init) => {
    if (init.method === 'PUT' && ++writes === 2) return new Response(null, { status: 403 });
    return original(url, init);
  };
  const result = await run(f, { mode: 'apply', planDigest: preview.planDigest });
  assert.equal(result.reason, 'HTTP_403');
  assert.equal(result.verified, 1);
  assert.equal(writes, 2);
});

test('final readback detects an edit after an earlier per-link confirmation', async () => {
  const f = fixture(); const preview = await run(f); const original = f.fetchImpl;
  let writes = 0;
  f.fetchImpl = async (url, init) => {
    const result = await original(url, init);
    if (init.method === 'PUT' && ++writes === 2) f.links.get('10001').object.summary = 'Concurrent edit';
    return result;
  };
  const result = await run(f, { mode: 'apply', planDigest: preview.planDigest });
  assert.equal(result.reason, 'READBACK');
  assert.equal(result.phase, 'final_readback');
});

test('overall deadline aborts a stalled request without disclosing transport details', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = run({ fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error(config.token)), { once: true });
  }) });
  t.mock.timers.tick(8 * 60 * 1000);
  assert.equal((await pending).reason, 'TRANSPORT');
});

for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} is bounded and not retried`, async () => {
    let calls = 0;
    const result = await run({ fetchImpl: async () => { calls++; return new Response('private body', { status }); } });
    assert.equal(result.code, 1);
    assert.equal(calls, 1);
    assert.match(result.reason, /^HTTP_/);
  });
}

test('malformed, oversized, redirected and wrong-media responses cannot authorize writes', async () => {
  for (const value of [response('x'.repeat(256 * 1024 + 1)), new Response('private invalid JSON',
    { headers: { 'content-type': 'application/json' } }), new Response('{}', { headers: { 'content-type': 'text/html' } })]) {
    assert.equal((await run({ fetchImpl: async () => value })).code, 1);
  }
  const redirected = response({ accountId: config.accountId, active: true });
  Object.defineProperty(redirected, 'redirected', { value: true });
  assert.equal((await run({ fetchImpl: async () => redirected })).reason, 'RESPONSE');
});

test('workflow retains main-only execution, protected writer boundary and reviewable fixed commands', () => {
  const yaml = readFileSync(new URL('../.github/workflows/jira-site-link-migration.yml', import.meta.url), 'utf8');
  assert.match(yaml, /github.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /environment: jira-readiness-writer/);
  assert.match(yaml, /group: jira-readiness-writer/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /default: preview/);
  assert.match(yaml, /run: node scripts\/jira-site-link-migration.mjs/);
  assert.doesNotMatch(yaml, /schedule:|pull_request_target|upload-artifact|: write|npm (ci|install)/);
  for (const action of yaml.matchAll(/uses: (\S+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
