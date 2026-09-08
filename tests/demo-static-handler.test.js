import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDemoStaticFileAdapter } from '../src/demo/static-file-adapter.mjs';
import { createDemoStaticHandler } from '../src/demo/static-handler.js';

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

function rawRequest(origin, requestPath, { method = 'GET' } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path: requestPath,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
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
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');

  const script = await rawRequest(origin, '/src/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
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
  assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp');
  assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');

  const legacyPath = await rawRequest(origin, '/platform-admin-demo/index.html');
  assert.equal(legacyPath.status, 200);
  assert.match(legacyPath.body, /platform/);

  const asset = await rawRequest(origin, '/assets/app.css', { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, '');
  assert.equal(asset.headers['content-type'], 'text/css; charset=utf-8');
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
