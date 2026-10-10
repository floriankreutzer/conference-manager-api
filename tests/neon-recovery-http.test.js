import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendPrivateMediaResponse } from '../src/http/private-media-response.js';
import { createRecoveryHttpClient, assertRecoveryHttpMedia, assertRecoveryNotModified,
  assertRecoveryHttpError, recoveryJson } from '../scripts/support/neon-recovery-http.mjs';
import { verifyRecoveryMediaFaultHttp } from '../scripts/support/neon-recovery-scenarios.mjs';
import { recoveryFaultReferences } from '../scripts/support/neon-recovery-faults.mjs';
import { recoveryReferences, recoveryBytes } from './support/neon-recovery-fixture.js';

const reference = recoveryFaultReferences(recoveryReferences)[0];
const mediaPath = `/api/v1/tenant/rooms/northwind-berlin-room-1/media/${reference.assetId}`;
const tenantId = reference.tenantId;
const cookieA = `cm_session=${'a'.repeat(43)}`;
const cookieB = `cm_session=${'b'.repeat(43)}`;

function mediaResponse(etag = null) {
  const headers = {};
  let bytes = Buffer.alloc(0);
  const outgoing = { statusCode: 0,
    setHeader(name, value) { headers[name.toLowerCase()] = String(value); },
    end(body) { if (body !== undefined) bytes = Buffer.from(body); } };
  sendPrivateMediaResponse({ request: { headers: etag === null ? {} : { 'if-none-match': etag } },
    response: outgoing, tenantId, assetId: reference.assetId, contentType: reference.contentType,
    bytes: recoveryBytes(reference) });
  return { status: outgoing.statusCode, headers, bytes };
}

function errorResponse(status, code) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    bytes: Buffer.from(JSON.stringify({ error: { code, requestId: 'bounded-request-id' } })) };
}

async function loopbackFixture(t, handler) {
  const server = http.createServer((incoming, outgoing) => {
    Promise.resolve(handler(incoming, outgoing)).catch(() => { outgoing.writeHead(500); outgoing.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const requests = [];
  const client = createRecoveryHttpClient({ assertActive() {} }, {
    request(options, callback) {
      assert.equal(options.hostname, '127.0.0.1');
      assert.equal(options.port, 3000);
      assert.equal(options.headers.Host, 'customer.demo.test:4443');
      assert.equal(options.headers.Origin, 'https://customer.demo.test:4443');
      requests.push(options);
      return http.request({ ...options, port: server.address().port }, callback);
    },
  });
  t.after(() => client.close());
  return { client, requests };
}

test('200 and 304 acceptance enforce every existing private-cache header plus exact content integrity', () => {
  const full = mediaResponse();
  const verified = assertRecoveryHttpMedia(full, reference);
  const conditional = mediaResponse(verified.etag);
  assertRecoveryNotModified(conditional, verified.etag);
  for (const headers of [
    { 'cache-control': 'public, must-revalidate' }, { 'cache-control': 'private, must-revalidate' },
    { 'cache-control': 'private, no-cache, max-age=60, must-revalidate' },
    { 'x-content-type-options': undefined }, { vary: 'Accept-Encoding' },
  ]) {
    assert.throws(() => assertRecoveryHttpMedia({ ...full, headers: { ...full.headers, ...headers } }, reference));
    assert.throws(() => assertRecoveryNotModified({ ...conditional, headers: { ...conditional.headers, ...headers } }, verified.etag));
  }
  const damaged = Buffer.from(full.bytes);
  damaged[0] ^= 1;
  assert.throws(() => assertRecoveryHttpMedia({ ...full, bytes: damaged }, reference), /MEDIA_STORAGE_INTEGRITY_FAILED/);
  assert.throws(() => assertRecoveryNotModified({ ...conditional, bytes: Buffer.from('private image data') }, verified.etag));
  assert.throws(() => assertRecoveryNotModified({ ...conditional,
    headers: { ...conditional.headers, 'content-type': reference.contentType } }, verified.etag));
});

test('fault HTTP assertions require normal, matching and wildcard failures with foreign/anonymous isolation', async () => {
  const etag = mediaResponse().headers.etag;
  const observed = [];
  const actor = (name, status, code) => ({ async request(path, options) {
    observed.push({ name, path, etag: options.etag });
    return errorResponse(status, code);
  } });
  const args = { path: mediaPath, etag,
    owner: actor('owner', 503, 'ROOM_MEDIA_UNAVAILABLE'), foreign: actor('foreign', 404, 'NOT_FOUND'),
    anonymous: actor('anonymous', 401, 'UNAUTHENTICATED') };
  const evidence = await verifyRecoveryMediaFaultHttp(args);
  assert.equal(evidence.matchingEtag, 503);
  assert.equal(observed.length, 9);
  for (const name of ['owner', 'foreign', 'anonymous']) {
    assert.deepEqual(observed.filter((entry) => entry.name === name).map((entry) => entry.etag), [null, etag, '*']);
  }
  await assert.rejects(verifyRecoveryMediaFaultHttp({ ...args, owner: { async request() { return mediaResponse(etag); } } }));
  const failure = errorResponse(503, 'ROOM_MEDIA_UNAVAILABLE');
  for (const response of [{ ...failure, headers: { ...failure.headers, etag } },
    { ...failure, headers: { ...failure.headers, 'cache-control': 'public, max-age=600' } },
    { ...failure, bytes: Buffer.from(JSON.stringify({ error: { code: 'ROOM_MEDIA_UNAVAILABLE',
      requestId: 'bounded-request-id', message: 'provider credential diagnostic' } })) }]) {
    assert.throws(() => assertRecoveryHttpError(response, 503, 'ROOM_MEDIA_UNAVAILABLE'));
  }
});

test('fixed-loopback HTTP sessions rotate cookies and use server-issued CSRF on the existing context write', async (t) => {
  const csrfA = 'c'.repeat(43);
  const csrfB = 'd'.repeat(43);
  const observations = [];
  const { client, requests } = await loopbackFixture(t, async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    observations.push({ path: incoming.url, cookie: incoming.headers.cookie, csrf: incoming.headers['x-csrf-token'], body });
    outgoing.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (incoming.url === '/api/v1/demo/session') {
      outgoing.setHeader('Set-Cookie', `${cookieA}; Path=/api; HttpOnly; SameSite=Lax; Secure; Max-Age=1800`);
      outgoing.end(JSON.stringify({ csrfToken: csrfA }));
    } else if (incoming.url === '/api/v1/demo/session/context') {
      outgoing.setHeader('Set-Cookie', `${cookieB}; Path=/api; HttpOnly; SameSite=Lax; Secure; Max-Age=1800`);
      outgoing.end(JSON.stringify({ csrfToken: csrfB, tenant: { id: tenantId }, demo: { persona: 'conference_manager' } }));
    } else outgoing.end(JSON.stringify({ locations: {} }));
  });
  await client.establish(tenantId);
  recoveryJson(await client.request('/api/v1/tenant/settings/locations?schemaVersion=3'));
  assert.equal(observations[0].cookie, undefined);
  assert.equal(observations[1].cookie, cookieA);
  assert.equal(observations[1].csrf, csrfA);
  assert.deepEqual(JSON.parse(observations[1].body), { tenantId, persona: 'conference_manager' });
  assert.equal(observations[2].cookie, cookieB);
  assert.equal(requests[1].method, 'PUT');
  for (const path of ['https://attacker.invalid/api', '//attacker.invalid', '/api/v1/demo/media/../../outside',
    '/api/v1/tenant/settings/locations?schemaVersion=3&redirect=evil']) {
    await assert.rejects(client.request(path), /NEON_RECOVERY_HTTP_ROUTE_INVALID/);
  }
  assert.equal(requests.length, 3);
});

test('HTTP probe never follows redirects, accepts broader cookies or exposes transport diagnostics', async (t) => {
  const redirect = await loopbackFixture(t, (incoming, outgoing) => {
    outgoing.writeHead(302, { Location: 'https://attacker.invalid/' });
    outgoing.end();
  });
  await assert.rejects(redirect.client.establish(tenantId), /NEON_RECOVERY_HTTP_RESPONSE_INVALID/);
  assert.equal(redirect.requests.length, 1);
  const broadCookie = await loopbackFixture(t, (incoming, outgoing) => {
    outgoing.writeHead(200, { 'Content-Type': 'application/json',
      'Set-Cookie': `${cookieA}; Domain=.demo.test; Path=/api; HttpOnly; SameSite=Lax; Secure` });
    outgoing.end(JSON.stringify({ csrfToken: 'c'.repeat(43) }));
  });
  await assert.rejects(broadCookie.client.establish(tenantId), { message: 'NEON_RECOVERY_HTTP_FAILED' });
  const failing = createRecoveryHttpClient({ assertActive() {} }, {
    request() { throw new Error('private transport credential diagnostic'); },
  });
  try { await assert.rejects(failing.request(mediaPath), { message: 'NEON_RECOVERY_HTTP_FAILED' }); }
  finally { failing.close(); }
});

test('oversized HTTP responses fail closed before any private payload becomes accepted evidence', async (t) => {
  const { client } = await loopbackFixture(t, (incoming, outgoing) => {
    outgoing.writeHead(200, { 'Content-Type': 'image/webp' });
    outgoing.end(Buffer.alloc(2 * 1024 * 1024 + 1));
  });
  await assert.rejects(client.request(mediaPath), { message: 'NEON_RECOVERY_HTTP_FAILED' });
});
