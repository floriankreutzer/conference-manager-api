import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

import { createDemoStaticFileAdapter } from '../src/demo/static-file-adapter.mjs';
import { createDemoStaticHandler } from '../src/demo/static-handler.js';
import { fingerprintDemoAssets } from '../scripts/fingerprint-demo-assets.mjs';

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'conference-manager-demo-static-'));
  await mkdir(path.join(root, 'platform-admin-demo'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>customer</title>', 'utf8');
  await writeFile(
    path.join(root, 'platform-admin-demo', 'index.html'),
    '<!doctype html><title>platform</title>',
    'utf8',
  );
  await writeFile(path.join(root, 'assets', 'app.css'), 'body{}', 'utf8');
  await writeFile(path.join(root, 'assets', 'data.txt'), 'not allowlisted', 'utf8');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const ready = true;', 'utf8');
  return root;
}

async function startStaticServer({ root, surface }) {
  const handler = createDemoStaticHandler({
    root,
    surface,
    fileAdapter: createDemoStaticFileAdapter({ root }),
  });
  const server = http.createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function rawRequest(origin, requestPath, { method = 'GET', headers = {} } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path: requestPath,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        bytes: Buffer.concat(chunks),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

function assertStrictStaticHeaders(headers) {
  assert.equal(headers['cache-control'], 'no-cache');
  assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.doesNotMatch(headers['content-security-policy'], /unsafe-inline/);
}

test('Customer hosted Demo serves browser assets from the same origin with strict headers', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server, origin } = await startStaticServer({ root, surface: 'customer' });
  t.after(() => closeServer(server));

  const page = await rawRequest(origin, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /customer/);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assertStrictStaticHeaders(page.headers);

  const script = await rawRequest(origin, '/src/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assertStrictStaticHeaders(script.headers);
  assert.match(script.body, /ready = true/);
});

test('Platform hosted Demo serves its own entrypoint while sharing only approved asset paths', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { server, origin } = await startStaticServer({ root, surface: 'platform' });
  t.after(() => closeServer(server));

  const page = await rawRequest(origin, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /platform/);
  assertStrictStaticHeaders(page.headers);

  const legacyPath = await rawRequest(origin, '/platform-admin-demo/index.html');
  assert.equal(legacyPath.status, 200);
  assert.match(legacyPath.body, /platform/);

  const asset = await rawRequest(origin, '/assets/app.css', { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, '');
  assert.equal(asset.headers['content-type'], 'text/css; charset=utf-8');
  assertStrictStaticHeaders(asset.headers);
});

test('hosted Demo static serving rejects traversal, symlink escape, unknown content and unsafe methods', async (t) => {
  const root = await fixtureRoot();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'conference-manager-demo-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'escape.js'), 'throw new Error("escaped");', 'utf8');
  await symlink(path.join(outside, 'escape.js'), path.join(root, 'src', 'escape.js'));
  const { server, origin } = await startStaticServer({ root, surface: 'customer' });
  t.after(() => closeServer(server));

  const traversal = await rawRequest(origin, '/assets/%252e%252e/src/app.js');
  assert.equal(traversal.status, 400);
  assertStrictStaticHeaders(traversal.headers);

  const encodedSeparator = await rawRequest(origin, '/assets%2fapp.css');
  assert.equal(encodedSeparator.status, 400);

  const symlinkEscape = await rawRequest(origin, '/src/escape.js');
  assert.equal(symlinkEscape.status, 400);

  const unknown = await rawRequest(origin, '/dashboard');
  assert.equal(unknown.status, 404);

  const unsupported = await rawRequest(origin, '/assets/data.txt');
  assert.equal(unsupported.status, 415);

  const post = await rawRequest(origin, '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('hosted Demo static transport fails closed without its injected filesystem port', () => {
  assert.throws(
    () => createDemoStaticHandler({ root: '.demo-frontend', surface: 'customer' }),
    /DEMO_STATIC_FILE_ADAPTER_REQUIRED/,
  );
});

test('public static text negotiates gzip/Brotli, representation ETags, HEAD and bodyless conditional responses', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const css = 'body{color:#123456;}\n'.repeat(300);
  await writeFile(path.join(root, 'assets', 'app.css'), css);
  const { server, origin } = await startStaticServer({ root, surface: 'customer' });
  t.after(() => closeServer(server));
  const identity = await rawRequest(origin, '/assets/app.css');
  for (const [encoding, decode] of [['gzip', gunzipSync], ['br', brotliDecompressSync]]) {
    const headers = { 'Accept-Encoding': encoding };
    const encoded = await rawRequest(origin, '/assets/app.css', { headers });
    assert.equal(encoded.status, 200);
    assert.equal(encoded.headers['content-encoding'], encoding);
    assert.equal(encoded.headers.vary, 'Accept-Encoding');
    assert.equal(decode(encoded.bytes).toString('utf8'), css);
    assert.ok(encoded.bytes.length < identity.bytes.length);
    assert.notEqual(encoded.headers.etag, identity.headers.etag);
    const cached = await rawRequest(origin, '/assets/app.css', {
      headers: { ...headers, 'If-None-Match': encoded.headers.etag },
    });
    assert.equal(cached.status, 304); assert.equal(cached.bytes.length, 0);
    assert.equal(cached.headers['content-length'], undefined);
    const head = await rawRequest(origin, '/assets/app.css', { method: 'HEAD', headers });
    assert.equal(head.bytes.length, 0);
    assert.equal(Number(head.headers['content-length']), encoded.bytes.length);
    const different = await rawRequest(origin, '/assets/app.css', {
      headers: { ...headers, 'If-None-Match': identity.headers.etag },
    });
    assert.equal(different.status, 200);
  }
  const weighted = await rawRequest(origin, '/assets/app.css', { headers: { 'Accept-Encoding': 'br;q=0, gzip' } });
  assert.equal(weighted.headers['content-encoding'], 'gzip');
  const forbidden = await rawRequest(origin, '/assets/app.css', { headers: { 'Accept-Encoding': '*;q=0' } });
  assert.equal(forbidden.status, 406);
  assert.equal(forbidden.headers.vary, 'Accept-Encoding');
});

test('only verified content-hash URLs are immutable; changed files invalidate cached bytes and old hashes', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'assets', 'app.css');
  const digest = createHash('sha256').update('body{}').digest('hex');
  const { server, origin } = await startStaticServer({ root, surface: 'platform' });
  t.after(() => closeServer(server));
  const url = `/assets/app.css?sha256=${digest}`;
  const immutable = await rawRequest(origin, url);
  assert.equal(immutable.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const invalid of [`/assets/app.css?sha256=${'a'.repeat(64)}`, `${url}&sha256=${digest}`, `${url}&v=1`]) {
    const result = await rawRequest(origin, invalid);
    assert.equal(result.status, 404); assertStrictStaticHeaders(result.headers);
  }
  await writeFile(filename, 'body{color:blue;}');
  const changed = await rawRequest(origin, '/assets/app.css', { headers: { 'If-None-Match': immutable.headers.etag } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, immutable.headers.etag);
  assert.match(changed.body, /color:blue/);
  assert.equal((await rawRequest(origin, url)).status, 404);
});

test('binary files are never compressed, rejected encodings and oversized static files fail safely', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const image = Buffer.alloc(1024, 42);
  await writeFile(path.join(root, 'assets', 'image.webp'), image);
  await writeFile(path.join(root, 'assets', 'too-large.js'), Buffer.alloc(8388609));
  const { server, origin } = await startStaticServer({ root, surface: 'customer' });
  t.after(() => closeServer(server));
  const binary = await rawRequest(origin, '/assets/image.webp', { headers: { 'Accept-Encoding': 'br, gzip' } });
  assert.equal(binary.headers['content-encoding'], undefined);
  assert.deepEqual(binary.bytes, image);
  const denied = await rawRequest(origin, '/assets/image.webp', { headers: { 'Accept-Encoding': 'br, identity;q=0' } });
  assert.equal(denied.status, 406);
  assert.equal((await rawRequest(origin, '/assets/too-large.js')).status, 413);
});

test('reviewed HTML packaging fingerprints local entry assets and refuses escaped files', async (t) => {
  const root = await fixtureRoot();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'conference-manager-fingerprint-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.html'), '<link href="./assets/app.css?v=old"><script src="./src/app.js"></script>');
  const result = await fingerprintDemoAssets(root);
  assert.deepEqual(result, { references: 2, files: 2 });
  const { server, origin } = await startStaticServer({ root, surface: 'customer' });
  t.after(() => closeServer(server));
  const page = await rawRequest(origin, '/');
  assert.match(page.body, /\/src\/app.js\?sha256=[a-f0-9]{64}/);
  assert.doesNotMatch(page.body, /v=old/);
  const cssUrl = page.body.match(/href="([^"]+)"/)[1];
  assert.equal((await rawRequest(origin, cssUrl)).headers['cache-control'], 'public, max-age=31536000, immutable');
  await writeFile(path.join(outside, 'escape.js'), 'private outside bytes');
  await symlink(path.join(outside, 'escape.js'), path.join(root, 'src', 'escape.js'));
  await writeFile(path.join(root, 'index.html'), '<script src="/src/escape.js"></script>');
  await assert.rejects(fingerprintDemoAssets(root), /DEMO_FINGERPRINT_PATH_INVALID/);
});

test('static representation work rejects excess concurrency and forged file authority', async (t) => {
  const root = await fixtureRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = createDemoStaticFileAdapter({ root });
  const file = await adapter.open('assets/app.css');
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => adapter.representation(file, { encoding: 'gzip' })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 8);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 8);
  await assert.rejects(adapter.representation({ ...file }), /DEMO_STATIC_FILE_REQUIRED/);
  const cached = await adapter.representation(await adapter.open('assets/app.css'), { encoding: 'gzip' });
  assert.equal(gunzipSync(cached.bytes).toString('utf8'), 'body{}');
});
