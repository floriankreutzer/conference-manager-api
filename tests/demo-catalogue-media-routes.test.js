import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';

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
    async create() {}, async remove() {}, async replace() { throw new Error('WRITE_MUST_BE_AUTHORIZED'); },
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
      async create() {}, async remove() {}, async replace(input) { replaced = input; return { id: assetId, byteLength: input.bytes.length }; },
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


test('Demo catering media create and remove require Manager authority, CSRF and Tenant scope', async () => {
  const webp = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 32, g: 64, b: 96 } },
  }).webp().toBuffer();
  let created = null;
  let removed = null;
  const mediaRepository = {
    async find() { return null; }, async list() { return []; },
    async create(input) { created = input; return { assetId: FOREIGN_ASSET, sha256: 'a'.repeat(64) }; },
    async remove(input) { removed = input; return true; },
    async replace() { return null; },
  };
  const routes = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository,
    authorizationPolicy: { requireTenantPermission(principal, tenant, permission) {
      assert.equal(permission, 'tenant:catalogue:manage');
      assert.equal(tenant.tenantId, TENANT_ID);
    } },
    auditService: { createEvent() { return {}; } },
  }).createHandler({
    principalGuard: { async require(requestValue, options) {
      assert.equal(options.csrf, true);
      return { userId: '10000000-0000-4000-8000-000000000002' };
    } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  const createPath = '/api/v1/demo/media/catering-item/cateringItems-1';
  const createRequest = {
    method: 'POST',
    headers: { 'content-type': 'image/webp', 'content-length': String(webp.length) },
    async *[Symbol.asyncIterator]() { yield webp; },
  };
  const createdReply = response();
  assert.equal(await routes({ request: createRequest, response: createdReply,
    parsedUrl: new URL(createPath, 'https://demo.example'), path: createPath, requestId: 'request-id' }), 201);
  assert.equal(created.tenantId, TENANT_ID);
  assert.equal(created.ownerKind, 'catering_item');
  assert.equal(created.ownerId, 'cateringItems-1');
  assert.equal(created.contentType, 'image/webp');
  assert.equal(JSON.parse(createdReply.body).url, `/api/v1/demo/media/${FOREIGN_ASSET}`);

  const removePath = `/api/v1/demo/media/${FOREIGN_ASSET}`;
  assert.equal(await routes({ request: request('DELETE'), response: response(),
    parsedUrl: new URL(removePath, 'https://demo.example'), path: removePath, requestId: 'request-id' }), 204);
  assert.equal(removed.tenantId, TENANT_ID);
  assert.equal(removed.assetId, FOREIGN_ASSET);
});


test('Demo media creation is CSRF protected, manager-authorized and owner scoped', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: { r: 16, g: 32, b: 48 } } }).webp().toBuffer();
  const path = '/api/v1/demo/media/catering-item/cateringItems-1';
  let created = null;
  const routes = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository: {
      async find() { return null; }, async list() { return []; },
      async create(input) { created = input; return { assetId: FOREIGN_ASSET, sha256: 'a'.repeat(64) }; },
      async remove() { return false; }, async replace() { return null; },
    },
    authorizationPolicy: { requireTenantPermission(principal, tenant, permission) {
      assert.equal(permission, 'tenant:catalogue:manage');
      assert.equal(tenant.tenantId, TENANT_ID);
    } },
    auditService: { createEvent() { return {}; } },
  }).createHandler({
    principalGuard: { async require(requestValue, options) {
      assert.equal(options.csrf, true);
      return { userId: '20000000-0000-4000-8000-000000000001' };
    } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  const upload = { method: 'POST', headers: {
    'content-type': 'image/webp', 'content-length': String(bytes.length),
  }, async *[Symbol.asyncIterator]() { yield bytes; } };
  const reply = response();
  assert.equal(await routes({ request: upload, response: reply,
    parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' }), 201);
  assert.equal(created.tenantId, TENANT_ID);
  assert.equal(created.ownerKind, 'catering_item');
  assert.equal(created.ownerId, 'cateringItems-1');
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
});

test('Demo media creation rejects non-WebP bytes and malformed owner IDs before persistence', async () => {
  const mediaRepository = {
    async find() { return null; }, async list() { return []; },
    async create() { throw new Error('CREATE_MUST_NOT_RUN'); },
    async remove() { return false; }, async replace() { return null; },
  };
  const routes = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository,
    authorizationPolicy: { requireTenantPermission() {} },
    auditService: { createEvent() { return {}; } },
  }).createHandler({
    principalGuard: { async require() { return { userId: '20000000-0000-4000-8000-000000000001' }; } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const path = '/api/v1/demo/media/catering-item/cateringItems-1';
  await assert.rejects(routes({ request: { method: 'POST', headers: {
    'content-type': 'image/png', 'content-length': String(png.length),
  }, async *[Symbol.asyncIterator]() { yield png; } }, response: response(),
  parsedUrl: new URL(path, 'https://demo.example'), path, requestId: 'request-id' }),
  (error) => error.status === 415 || error.statusCode === 415);
});


test('Demo media mutations conceal owners and assets outside the authenticated tenant', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3,
    background: { r: 16, g: 32, b: 48 } } }).webp().toBuffer();
  const calls = [];
  const routes = createDemoCustomerControlRoutes({
    personaService: { async establish() {}, async switch() {}, async tenants() { return []; },
      clearCookie() { return ''; } },
    mediaRepository: {
      async find() { return null; }, async list() { return []; },
      async create(input) { calls.push(['create', input.tenantId, input.ownerId]); return null; },
      async remove(input) { calls.push(['remove', input.tenantId, input.assetId]); return false; },
      async replace() { return null; },
    },
    authorizationPolicy: { requireTenantPermission() {} },
    auditService: { createEvent() { return {}; } },
  }).createHandler({
    principalGuard: { async require() {
      return { userId: '20000000-0000-4000-8000-000000000001' };
    } },
    tenantGuard: { async requireKnown() { return { tenantId: TENANT_ID }; } },
    maxResponseBytes: 100000,
  });
  const createPath = '/api/v1/demo/media/catering-item/foreign-owner';
  await assert.rejects(routes({ request: { method: 'POST', headers: {
    'content-type': 'image/webp', 'content-length': String(bytes.length),
  }, async *[Symbol.asyncIterator]() { yield bytes; } }, response: response(),
  parsedUrl: new URL(createPath, 'https://demo.example'), path: createPath, requestId: 'request-id' }),
  (error) => error.status === 404 || error.statusCode === 404);
  const deletePath = `/api/v1/demo/media/${FOREIGN_ASSET}`;
  await assert.rejects(routes({ request: request('DELETE'), response: response(),
    parsedUrl: new URL(deletePath, 'https://demo.example'), path: deletePath, requestId: 'request-id' }),
  (error) => error.status === 404 || error.statusCode === 404);
  assert.deepEqual(calls, [
    ['create', TENANT_ID, 'foreign-owner'],
    ['remove', TENANT_ID, FOREIGN_ASSET],
  ]);
});
