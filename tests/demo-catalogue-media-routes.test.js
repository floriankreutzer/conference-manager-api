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
