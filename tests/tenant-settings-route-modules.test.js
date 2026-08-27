import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import {
  TENANT_BOOKING_POLICY_ROUTES,
  createTenantBookingPolicyHttpHandler,
  tenantBookingPolicyRouteKey,
  tenantBookingPolicyRoutes,
} from '../src/http/settings/booking-policies.js';
import {
  TENANT_COST_ALLOCATION_ROUTES,
  createTenantCostAllocationHttpHandler,
  tenantCostAllocationRouteKey,
  tenantCostAllocationRoutes,
} from '../src/http/settings/cost-allocation.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

function request(method, body = null, csrf = false) {
  const serialized = body === null ? null : JSON.stringify(body);
  const stream = Readable.from(
    serialized === null ? [] : [Buffer.from(serialized)],
  );
  stream.method = method;
  stream.headers = {
    ...(serialized === null ? {} : {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(serialized)),
    }),
    ...(csrf ? { 'x-csrf-token': 'valid' } : {}),
  };
  return stream;
}

function response() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(value) {
      this.body = value ? JSON.parse(value) : null;
    },
  };
}

function runtime(createHandler) {
  const calls = [];
  const principal = { tenantId: TENANT_ID, userId: USER_ID };
  const service = {
    async getCurrent() {
      return { schemaVersion: 1, revision: 1, configuration: {} };
    },
    async update(args) {
      calls.push(args);
      return {
        schemaVersion: 1,
        revision: args.expectedRevision + 1,
        configuration: args.configuration,
      };
    },
    async listHistory() {
      return [];
    },
    async getRevision() {
      return null;
    },
  };
  const handler = createHandler({
    service,
    principalGuard: {
      async require(actualRequest, { csrf }) {
        if (csrf && actualRequest.headers['x-csrf-token'] !== 'valid') {
          throw new ApiError(403, 'CSRF_INVALID');
        }
        return principal;
      },
    },
    tenantGuard: {
      async requireKnown(actualPrincipal) {
        assert.equal(actualPrincipal, principal);
        return { tenantId: actualPrincipal.tenantId };
      },
    },
    maxBodyBytes: 64_000,
    maxResponseBytes: 64_000,
  });
  return { calls, handler };
}

function context(path, method, body = null, csrf = false) {
  return {
    request: request(method, body, csrf),
    response: response(),
    parsedUrl: new URL('https://example.test' + path),
    path: new URL('https://example.test' + path).pathname,
    requestId: REQUEST_ID,
  };
}

const domains = [
  {
    name: 'booking policy',
    routes: TENANT_BOOKING_POLICY_ROUTES,
    createHandler: createTenantBookingPolicyHttpHandler,
    routeKey: tenantBookingPolicyRouteKey,
    routeModule: tenantBookingPolicyRoutes,
  },
  {
    name: 'cost allocation',
    routes: TENANT_COST_ALLOCATION_ROUTES,
    createHandler: createTenantCostAllocationHttpHandler,
    routeKey: tenantCostAllocationRouteKey,
    routeModule: tenantCostAllocationRoutes,
  },
];

for (const domain of domains) {
  test(domain.name + ' route module claims only its bounded paths', () => {
    assert.ok(domain.routeKey(domain.routes.current));
    assert.ok(domain.routeKey(domain.routes.history));
    assert.ok(domain.routeKey(domain.routes.history + '/12'));
    assert.equal(domain.routeKey('/api/v1/tenant/settings/unrelated'), null);
    assert.equal(typeof domain.routeModule.createHandler, 'function');
  });

  test(domain.name + ' mutation requires CSRF before body processing', async () => {
    const { calls, handler } = runtime(domain.createHandler);
    await assert.rejects(
      handler(context(domain.routes.current, 'PUT', {
        schemaVersion: 1,
        expectedRevision: 1,
        configuration: {},
      })),
      (error) => error instanceof ApiError && error.code === 'CSRF_INVALID',
    );
    assert.equal(calls.length, 0);
  });

  test(domain.name + ' mutation accepts only the exact settings envelope', async () => {
    const { calls, handler } = runtime(domain.createHandler);
    await assert.rejects(
      handler(context(domain.routes.current, 'PUT', {
        schemaVersion: 1,
        expectedRevision: 1,
        configuration: {},
        tenantId: TENANT_ID,
      }, true)),
      (error) => error instanceof ApiError && error.code === 'VALIDATION_FAILED',
    );
    assert.equal(calls.length, 0);

    const accepted = context(domain.routes.current, 'PUT', {
      schemaVersion: 1,
      expectedRevision: 1,
      configuration: {},
    }, true);
    assert.equal(await handler(accepted), 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tenantContext.tenantId, TENANT_ID);
    assert.equal(Object.hasOwn(calls[0], 'tenantId'), false);
  });

  test(domain.name + ' reads reject browser-selected Tenant query scope', async () => {
    const { handler } = runtime(domain.createHandler);
    await assert.rejects(
      handler(context(
        domain.routes.current + '?tenantId=' + TENANT_ID,
        'GET',
      )),
      (error) => error instanceof ApiError && error.code === 'VALIDATION_FAILED',
    );
  });

  test(domain.name + ' reads reject request bodies', async () => {
    const { handler } = runtime(domain.createHandler);
    await assert.rejects(
      handler(context(domain.routes.current, 'GET', { ignored: true })),
      (error) => (
        error instanceof ApiError
        && error.code === 'REQUEST_BODY_NOT_ALLOWED'
      ),
    );
  });
}
