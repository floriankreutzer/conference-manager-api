import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { createTargetLoadTransport } from '../scripts/support/target-load-transport.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW, RUN } from './support/target-load-environment.js';

// Ephemeral test-only CA/key; nothing is committed, printed or trusted globally.
// Only the dependency seam maps the fixed canonical destination to owned loopback.
test('target HTTPS edge verifies actual TLS and Host, rejects an untrusted certificate and never follows redirects', async t => {
  const directory = await mkdtemp('/tmp/cm-target-load-tls-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = `cm-saas38-load-${RUN}-customer.onrender.com`;
  const keyPath = `${directory}/key.pem`; const certPath = `${directory}/cert.pem`;
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', keyPath, '-out', certPath],
  { stdio: 'ignore', timeout: 10_000 });
  assert.equal(generated.status, 0);
  const certificate = await readFile(certPath); let requests = 0; let mode = 'valid';
  const server = https.createServer({ key: await readFile(keyPath), cert: certificate }, (request, response) => {
    requests += 1; assert.equal(request.headers.host, host); assert.equal(request.url, '/api/v1/session');
    assert.match(request.headers.cookie, /^cm_session=[A-Za-z0-9_-]{43}$/);
    response.writeHead(mode === 'redirect' ? 302 : 200, { 'Content-Type': 'application/json',
      ...(mode === 'redirect' ? { Location: 'https://foreign.invalid' } : {}) }); response.end('{"ok":true}');
  });
  server.on('tlsClientError', () => {}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origins = Object.fromEntries(['customer', 'platform'].map(surface => [surface,
    `https://cm-saas38-load-${RUN}-${surface}.onrender.com`]));
  function transport(trusted) {
    return createTargetLoadTransport({ values: targetScopeValues(targetLoadSetupEnvironment()), origins,
      clock: () => NOW, async recordAttempt() {}, request(url, options, callback) {
        assert.equal(url.origin, origins.customer); assert.equal(options.rejectUnauthorized, true);
        return https.request(url, { ...options, port: server.address().port, servername: url.hostname,
          lookup(_hostname, options, done) {
            if (options.all) done(null, [{ address: '127.0.0.1', family: 4 }]); else done(null, '127.0.0.1', 4);
          },
          headers: { ...options.headers, Host: url.host }, ...(trusted ? { ca: certificate } : {}) }, callback);
      } });
  }
  const input = { kind: 'session_read', method: 'GET', path: '/api/v1/session', binary: false,
    cookie: `cm_session=${'s'.repeat(43)}`, signal: AbortSignal.timeout(5000) };
  const accepted = transport(true); assert.deepEqual((await accepted.exchange(input)).body, { ok: true });
  assert.equal(requests, 1);
  await assert.rejects(transport(false).exchange(input), /^Error: LOAD_TARGET_HTTP_FAILED$/); assert.equal(requests, 1);
  mode = 'redirect'; await assert.rejects(accepted.exchange(input), /^Error: LOAD_TARGET_HTTP_FAILED$/);
  assert.equal(requests, 2); accepted.close();
});
