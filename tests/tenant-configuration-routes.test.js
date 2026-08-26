import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { createTenantConfigurationRouteContract } from '../src/http/tenant-configuration-route.js';

const PRINCIPAL = Object.freeze({ userId: '11111111-1111-4111-8111-111111111111' });
const TENANT = Object.freeze({ tenantId: '22222222-2222-4222-8222-222222222222' });
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function request(method, body = null) {
  const serialized = body === null ? null : Buffer.from(JSON.stringify(body));
  return {
    method,
    headers: serialized === null ? { 'content-length': '0' } : {
      'content-type': 'application/json',
      'content-length': String(serialized.byteLength),
    },
    async *[Symbol.asyncIterator]() { if (serialized !== null) yield serialized; },
  };
}

function response() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(value = '') { this.body = String(value); },
    headers,
  };
}

function runtime(overrides = {}) {
  const calls = [];
  const service = {
    async getCurrent(args) { calls.push(['getCurrent', args]); return { revision: 1, configuration: {} }; },
    async update(args) { calls.push(['update', args]); return { revision: 2, configuration: args.configuration }; },
    async listHistory(args) { calls.push(['listHistory', args]); return []; },
    async getRevision(args) { calls.push(['getRevision', args]); return { revision: Number(args.revision) }; },
    async rollback(args) { calls.push(['rollback', args]); return { revision: args.expectedRevision + 1 }; },
  };
  return {
    calls,
    service,
    principalGuard: {
      async require(_request, options) { calls.push(['principal', options]); return PRINCIPAL; },
    },
    tenantGuard: {
      async requireKnown(principal) { calls.push(['tenant', principal]); return TENANT; },
    },
    maxBodyBytes: 262_144,
    maxResponseBytes: 524_288,
    ...overrides,
  };
}

async function invoke(handler, { method, path, query = '', body = null }) {
  const res = response();
  const status = await handler({
    request: request(method, body),
    response: res,
    parsedUrl: new URL(`${path}${query}`, 'https://example.invalid'),
    path,
    requestId: REQUEST_ID,
  });
  return { status, response: res, payload: res.body ? JSON.parse(res.body) : null };
}

test('Tenant configuration route keys have bounded cardinality across domains', () => {
  const organization = createTenantConfigurationRouteContract('/api/v1/tenant/organization');
  const catalog = createTenantConfigurationRouteContract('/api/v1/tenant/catalog');
  for (const [contract, base] of [
    [organization, '/api/v1/tenant/organization'],
    [catalog, '/api/v1/tenant/catalog'],
  ]) {
    assert.equal(contract.routeKey(base), 'application_configuration');
    assert.equal(contract.routeKey(`${base}/history`), 'application_configuration');
    assert.equal(contract.routeKey(`${base}/revisions/12`), 'application_configuration');
    assert.equal(contract.routeKey(`${base}/revisions/12/rollback`), 'application_configuration');
    assert.equal(contract.routeKey(`${base}/other`), null);
  }
});

test('Tenant configuration GET is tenant-bound and does not require CSRF', async () => {
  const environment = runtime();
  const handler = createTenantConfigurationRouteContract('/api/v1/tenant/organization').createHandler(environment);
  const result = await invoke(handler, { method: 'GET', path: '/api/v1/tenant/organization' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.result.revision, 1);
  assert.deepEqual(environment.calls[0], ['principal', { csrf: false }]);
  const serviceCall = environment.calls.find(([name]) => name === 'getCurrent')[1];
  assert.equal(serviceCall.tenantContext, TENANT);
  assert.equal(serviceCall.correlationId, REQUEST_ID);
});

test('Tenant configuration mutation requires CSRF and forwards only the exact protocol', async () => {
  const environment = runtime();
  const handler = createTenantConfigurationRouteContract('/api/v1/tenant/catalog').createHandler(environment);
  const configuration = { services: [], cateringPackages: [], cateringItems: [] };
  const result = await invoke(handler, {
    method: 'PUT',
    path: '/api/v1/tenant/catalog',
    body: { expectedRevision: 1, configuration },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(environment.calls[0], ['principal', { csrf: true }]);
  const serviceCall = environment.calls.find(([name]) => name === 'update')[1];
  assert.equal(serviceCall.expectedRevision, 1);
  assert.deepEqual(serviceCall.configuration, configuration);
  assert.equal(Object.hasOwn(serviceCall, 'tenantId'), false);
});

test('routes reject caller-controlled Tenant authority and unknown query fields', async () => {
  const environment = runtime();
  const handler = createTenantConfigurationRouteContract('/api/v1/tenant/locations').createHandler(environment);
  await assert.rejects(
    invoke(handler, {
      method: 'PUT',
      path: '/api/v1/tenant/locations',
      body: { expectedRevision: 1, configuration: { sites: [] }, tenantId: TENANT.tenantId },
    }),
    (error) => error instanceof ApiError && error.statusCode === 400 && error.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    invoke(handler, {
      method: 'GET',
      path: '/api/v1/tenant/locations/history',
      query: '?tenantId=other',
    }),
    (error) => error instanceof ApiError && error.statusCode === 400 && error.code === 'VALIDATION_FAILED',
  );
  assert.equal(environment.calls.some(([name]) => name === 'update'), false);
});

test('history and rollback use bounded revision inputs', async () => {
  const environment = runtime();
  const handler = createTenantConfigurationRouteContract('/api/v1/tenant/booking-policies').createHandler(environment);
  const history = await invoke(handler, {
    method: 'GET',
    path: '/api/v1/tenant/booking-policies/history',
    query: '?limit=25',
  });
  assert.equal(history.status, 200);
  assert.equal(environment.calls.find(([name]) => name === 'listHistory')[1].limit, 25);
  const rollback = await invoke(handler, {
    method: 'POST',
    path: '/api/v1/tenant/booking-policies/revisions/2/rollback',
    body: { expectedRevision: 4 },
  });
  assert.equal(rollback.status, 200);
  const call = environment.calls.find(([name]) => name === 'rollback')[1];
  assert.equal(call.sourceRevision, '2');
  assert.equal(call.expectedRevision, 4);
});
