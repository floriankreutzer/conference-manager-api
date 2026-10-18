import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { loadTargetOperatorConfig } from '../scripts/support/target-load-operator-config.mjs';
import { loadTargetSetupConfig } from '../scripts/support/target-load-setup-config.mjs';
import { loadTargetRuntimeConfig } from '../scripts/support/target-load-runtime-config.mjs';
import { awaitTargetOperatorRelease } from '../scripts/support/target-load-operator-gate.mjs';
import { createTargetOperatorServer } from '../scripts/support/target-load-operator-http.mjs';
import { startTargetLoadOperator } from '../scripts/target-load-operator.mjs';
import { targetLoadSetupEnvironment, targetLoadEnvironment, targetLoadOperatorEnvironment, NOW, SHA, RUN }
  from './support/target-load-environment.js';
import { targetLoadManifest } from './support/target-load-manifest.js';

const environment = targetLoadOperatorEnvironment;

test('operator mode is explicit, source/service-bound and separate from every runtime and local installer', () => {
  const env = environment(); assert.equal(loadTargetSetupConfig(env, NOW).population, 100);
  assert.equal(loadTargetOperatorConfig(env, NOW).port, 10000);
  for (const patch of [{ LOAD_OPERATOR_MODE: undefined }, { RENDER: 'false' }, { RENDER_GIT_COMMIT: 'c'.repeat(40) },
    { RENDER_GIT_BRANCH: 'other' }, { RENDER_SERVICE_TYPE: 'worker' }, { RENDER_EXTERNAL_HOSTNAME: 'other.onrender.com' },
    { RENDER_EXTERNAL_URL: 'http://other.onrender.com' }, { LOAD_OPERATOR_TOKEN: env.LOAD_OBSERVER_TOKEN },
    { PORT: '18012' }, { PORT: '0' }, { PORT: '65536' }, { DATABASE_URL: 'private-material' }]) {
    assert.throws(() => loadTargetSetupConfig({ ...env, ...patch }, NOW));
  }
  assert.throws(() => loadTargetRuntimeConfig({ ...targetLoadEnvironment(), LOAD_OPERATOR_MODE: env.LOAD_OPERATOR_MODE }, NOW));
  assert.throws(() => loadTargetSetupConfig({ ...targetLoadSetupEnvironment(), LOAD_OPERATOR_TOKEN: env.LOAD_OPERATOR_TOKEN }, NOW));
});

function exchange(server, settings, { path = '/__load/status', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, agent: false,
      headers: { Host: new URL(settings.origin).host, Authorization: `Bearer ${settings.token}`, ...headers } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.once('end', () => resolve({ code: response.statusCode, headers: response.headers, body }));
    }); request.once('error', reject); request.end();
  });
}

test('operator observation is read-only, exact-host/auth protected, bounded and permanently expires', async t => {
  const settings = loadTargetOperatorConfig(environment(), NOW); let now = NOW;
  const server = createTargetOperatorServer({ settings, clock: () => now, status: () => ({ phase: 'waiting' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const good = await exchange(server, settings); assert.equal(good.code, 200); assert.equal(good.body, '{"phase":"waiting"}');
  assert.equal(good.headers['cache-control'], 'private, no-store'); assert.ok(good.headers['strict-transport-security']);
  for (const input of [{ headers: { Host: 'wrong.onrender.com' } }, { headers: { Authorization: 'Bearer wrong' } },
    { method: 'POST' }, { path: '/__load/status?ready=true' }, { headers: { 'Content-Length': '1' } }]) {
    assert.equal((await exchange(server, settings, input)).code, 404);
  }
  assert.equal((await exchange(server, settings, { path: '/__load/health', headers: { Authorization: '' } })).code, 200);
  now = settings.scope.expiresMs; assert.equal((await exchange(server, settings)).code, 503);
  now = NOW; assert.equal((await exchange(server, settings)).code, 503);
});

test('operator gate cannot issue HTTP authority or release before exact independent database readiness', async () => {
  const env = environment(); const queries = []; let checks = 0; let closed = 0; let prepared = 0;
  const pool = { async query(sql, parameters) {
    queries.push({ sql, parameters });
    if (sql.startsWith('SELECT run_id')) return { rowCount: 1, rows: [{ run_id: RUN, release_sha: SHA,
      expires_at: new Date(env.LOAD_EXPIRES_AT), ready: ++checks > 1 }] };
    return { rows: [] };
  } };
  await awaitTargetOperatorRelease({ env, clock: () => NOW, async sleep(ms) { assert.equal(ms, 5000); },
    async verifyDatabase() {}, prepared() { prepared += 1; },
    persistenceFactory: () => ({ pool, async close() { closed += 1; } }) });
  assert.equal(checks, 2); assert.equal(prepared, 1); assert.equal(closed, 1);
  assert.equal(queries.some(row => /GRANT|UPDATE|DELETE/.test(row.sql)), false);
  assert.ok(queries[0].sql.startsWith('CREATE TABLE public.saas38_load_operator_gate'));
  await assert.rejects(awaitTargetOperatorRelease({ env, clock: () => NOW, async verifyDatabase() { throw new Error('private'); },
    persistenceFactory: () => ({ pool, async close() { closed += 1; } }) }), /^Error: LOAD_OPERATOR_GATE_FAILED$/);
  assert.equal(closed, 2);
});

test('operator holds private fixture custody through setup, independent release and one controller invocation', async t => {
  const env = environment(); const manifest = await targetLoadManifest({ expiresAt: env.LOAD_EXPIRES_AT }); const calls = [];
  let settings;
  const runtime = await startTargetLoadOperator({ env, clock: () => NOW,
    async setup() { calls.push('setup'); return manifest; },
    async gate({ prepared }) { calls.push('gate'); prepared(); },
    async controller({ readManifest }) { calls.push('controller'); assert.deepEqual(await readManifest(), manifest);
      return { schemaVersion: 1, warmObjectivesMet: false }; },
    serverFactory(options) { settings = options.settings;
      const server = createTargetOperatorServer(options); const listen = server.listen.bind(server);
      server.listen = (_port, _host, resolve) => listen(0, '127.0.0.1', resolve); return server; },
  });
  t.after(() => runtime.stop()); await runtime.done;
  assert.deepEqual(calls, ['setup', 'gate', 'controller']);
  const response = await exchange(runtime.server, settings); assert.equal(response.code, 200);
  assert.deepEqual(JSON.parse(response.body), { phase: 'measured', evidence: { schemaVersion: 1, warmObjectivesMet: false } });
  assert.equal(response.body.includes('cm_session='), false);
});

test('operator setup failure retains only fixed failure status and never opens the release/campaign path', async t => {
  const env = environment(); let settings; let later = 0;
  const runtime = await startTargetLoadOperator({ env, clock: () => NOW,
    async setup() { throw new Error('private-cookie-or-database'); }, async gate() { later += 1; },
    async controller() { later += 1; }, serverFactory(options) { settings = options.settings;
      const server = createTargetOperatorServer(options); const listen = server.listen.bind(server);
      server.listen = (_port, _host, resolve) => listen(0, '127.0.0.1', resolve); return server; },
  }); t.after(() => runtime.stop()); await runtime.done;
  assert.equal(later, 0); assert.equal((await exchange(runtime.server, settings)).body, '{"phase":"failed"}');
});

test('operator shutdown requests process termination and cannot release work after an awaited setup completes', async () => {
  const env = environment(); const manifest = await targetLoadManifest({ expiresAt: env.LOAD_EXPIRES_AT });
  let complete; let exits = 0; let later = 0;
  const runtime = await startTargetLoadOperator({ env, clock: () => NOW, exit(code) { assert.equal(code, 1); exits += 1; },
    setup: () => new Promise(resolve => { complete = resolve; }), async gate() { later += 1; },
    async controller() { later += 1; }, serverFactory(options) {
      const server = createTargetOperatorServer(options); const listen = server.listen.bind(server);
      server.listen = (_port, _host, resolve) => listen(0, '127.0.0.1', resolve); return server;
    },
  });
  await runtime.stop(); assert.equal(exits, 1); complete(manifest); await runtime.done;
  assert.equal(later, 0);
});
