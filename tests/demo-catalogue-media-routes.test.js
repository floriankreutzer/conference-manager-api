import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoCustomerControlRoutes } from '../src/demo/http/customer-control-routes.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const FOREIGN_ASSET = '52000000-0000-4000-8000-000000000011';

function request(method = 'GET') {
  return { method, headers: {}, async *[Symbol.asyncIterator]() {} };
}

function response() {
  const headers = new Map();
  return {
    headers,
    setHeader(key, value) { headers.set(key.toLowerCase(), value); },
    end(value) { this.body = value; },
  };
}

function handler(mediaRepository, requirePrincipal = async () => ({ userId: 'user' })) {
  const module = createDemoCustomerControlRoutes({
    personaService: {
      async establish() {}, async switch() {}, async tenants() { return []; }, clearCookie() { return ''; },
    },
    mediaRepository,
  });
  return module.createHandler({
    principalGuard: { require: requirePrincipal },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
}

test('Demo media requires a customer session and reads only the current tenant', async () => {
  const inspected = [];
  const handle = handler({
    async find(input) { inspected.push(input); return null; },
    async list(input) { inspected.push(input); return []; },
  });
  const path = `/api/v1/demo/media/${FOREIGN_ASSET}`;
  const reply = response();
  await assert.rejects(handle({ request: request(), response: reply,
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' }),
  (error) => error.status === 404 || error.statusCode === 404);
  assert.deepEqual(inspected, [{ tenantId: TENANT_ID, assetId: FOREIGN_ASSET }]);

  const denied = handler({ async find() { throw new Error('MEDIA_LEAK'); }, async list() { return []; } },
    async () => { throw new Error('UNAUTHENTICATED'); });
  await assert.rejects(denied({ request: request(), response: response(),
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' }),
  /UNAUTHENTICATED/);
});

test('Demo media listing exposes only the authenticated tenant and no cache', async () => {
  const inspected = [];
  const handle = handler({
    async find() { return null; },
    async list(input) { inspected.push(input); return [{ id: FOREIGN_ASSET,
      ownerKind: 'room_plan', ownerId: 'room-1', contentType: 'image/png', altText: 'Plan' }]; },
  });
  const path = '/api/v1/demo/media';
  const reply = response();
  await handle({ request: request(), response: reply,
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' });
  assert.deepEqual(inspected, [{ tenantId: TENANT_ID }]);
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  assert.equal(JSON.parse(reply.body).assets[0].url, `${path}/${FOREIGN_ASSET}`);
});

test('Demo media replacement requires a manager, CSRF and matching MIME', async () => {
  const inspected = [];
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const path = `/api/v1/demo/media/${FOREIGN_ASSET}`;
  const upload = () => ({ method: 'PUT', headers: { 'content-type': 'image/png' },
    async *[Symbol.asyncIterator]() { yield png; } });
  const mediaRepository = {
    async find() { return null; }, async list() { return []; },
    async replace() { throw new Error('WRITE_MUST_BE_AUTHORIZED'); },
  };
  const denied = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository,
    authorizationPolicy: { requireTenantPermission(principal, tenant, permission) {
      inspected.push({ principal, tenant, permission });
      throw new Error('FORBIDDEN');
    } },
    auditService: { createEvent() {} },
  }).createHandler({
    principalGuard: { async require(req, options) {
      assert.equal(options.csrf, true); return { userId: 'user' };
    } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  await assert.rejects(denied({ request: upload(), response: response(),
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' }),
  /FORBIDDEN/);
  assert.equal(inspected[0].permission, 'tenant:catalogue:manage');
});

test('Demo media replacement accepts a numeric Content-Length after authorization', async () => {
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const assetId = FOREIGN_ASSET;
  const path = `/api/v1/demo/media/${assetId}`;
  let replaced = null;
  const routes = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository: {
      async find() { return null; }, async list() { return []; },
      async replace(input) { replaced = input; return { id: assetId, byteLength: input.bytes.length }; },
    },
    authorizationPolicy: { requireTenantPermission(principal, tenant, permission) {
      assert.equal(permission, 'tenant:catalogue:manage');
      assert.equal(tenant.tenantId, TENANT_ID);
    } },
    auditService: { createEvent() { return {}; } },
  }).createHandler({
    principalGuard: { async require(requestValue, options) {
      assert.equal(options.csrf, true); return { userId: 'user' };
    } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  const upload = { method: 'PUT', headers: {
    'content-type': 'image/png', 'content-length': String(bytes.length),
  }, async *[Symbol.asyncIterator]() { yield bytes; } };
  const reply = response();
  const status = await routes({ request: upload, response: reply,
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' });
  assert.equal(status, 200);
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(replaced.bytes, bytes);
  assert.equal(replaced.tenantId, TENANT_ID);
});
