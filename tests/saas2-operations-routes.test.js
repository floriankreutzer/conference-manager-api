import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import { TenantUserLifecycleConflictError } from '../src/application/tenant-user-lifecycle-errors.js';
import {
  createTenantCapabilityViewHttpHandler,
  tenantCapabilityViewRouteModule,
} from '../src/http/settings/tenant-capability-view-routes.js';
import {
  createTenantUserLifecycleHttpHandler,
  tenantUserLifecycleRouteModule,
} from '../src/http/settings/tenant-user-lifecycle-routes.js';
import {
  createTenantAuditQueryHttpHandler,
  tenantAuditQueryRouteModule,
} from '../src/http/tenant-audit-query-routes.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

function request(method = 'GET', body = null) {
  const bytes = body === null ? [] : [Buffer.from(body)];
  const value = Readable.from(bytes);
  value.method = method;
  value.headers = body === null ? {} : {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  return value;
}

function response() {
  const headers = new Map();
  return {
    statusCode: null,
    body: null,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    end(body = '') {
      this.body = body ? JSON.parse(body) : null;
    },
  };
}

function guards() {
  const calls = [];
  const principal = { userId: USER_ID, tenantId: TENANT_ID };
  return {
    calls,
    principalGuard: {
      async require(requestValue, options) {
        calls.push({ requestValue, options });
        return principal;
      },
    },
    tenantGuard: {
      async requireKnown(value) {
        assert.equal(value, principal);
        return { tenantId: TENANT_ID, status: 'active' };
      },
    },
  };
}

test('Tenant User lifecycle route extends listing filters and requires CSRF for exact access mutations', async () => {
  const guard = guards();
  let listed;
  let changed;
  const handler = createTenantUserLifecycleHttpHandler({
    tenantUserLifecycleService: {
      async listUsers(values) {
        listed = values;
        return { users: [], nextAfterId: null };
      },
      async setAccess(values) {
        changed = values;
        return { id: USER_ID, lifecycle: { status: 'disabled', version: 2 } };
      },
    },
    principalGuard: guard.principalGuard,
    tenantGuard: guard.tenantGuard,
    maxBodyBytes: 4_096,
    maxResponseBytes: 32_768,
  });

  const listResponse = response();
  assert.equal(await handler({
    request: request(),
    response: listResponse,
    parsedUrl: new URL(
      `/api/v1/tenant/users?limit=25&search=Alex&status=active&role=tenant_admin&providerLink=linked`,
      'https://conference.example',
    ),
    path: '/api/v1/tenant/users',
    requestId: CORRELATION_ID,
  }), 200);
  assert.deepEqual({
    limit: listed.limit,
    search: listed.search,
    status: listed.status,
    role: listed.role,
    providerLink: listed.providerLink,
  }, {
    limit: 25,
    search: 'Alex',
    status: 'active',
    role: 'tenant_admin',
    providerLink: 'linked',
  });

  const body = JSON.stringify({ active: false, expectedVersion: 1 });
  const mutationResponse = response();
  assert.equal(await handler({
    request: request('PUT', body),
    response: mutationResponse,
    parsedUrl: new URL(`/api/v1/tenant/users/${USER_ID}/access`, 'https://conference.example'),
    path: `/api/v1/tenant/users/${USER_ID}/access`,
    requestId: CORRELATION_ID,
  }), 200);
  assert.equal(guard.calls.at(-1).options.csrf, true);
  assert.equal(changed.tenantContext.tenantId, TENANT_ID);
  assert.deepEqual({ active: changed.active, expectedVersion: changed.expectedVersion }, {
    active: false,
    expectedVersion: 1,
  });

  await assert.rejects(
    handler({
      request: request(),
      response: response(),
      parsedUrl: new URL(`/api/v1/tenant/users?tenantId=${TENANT_ID}`, 'https://conference.example'),
      path: '/api/v1/tenant/users',
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
  await assert.rejects(
    handler({
      request: request('GET', '{}'),
      response: response(),
      parsedUrl: new URL('/api/v1/tenant/users', 'https://conference.example'),
      path: '/api/v1/tenant/users',
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'REQUEST_BODY_NOT_ALLOWED',
  );
});

test('Tenant User lifecycle transport preserves version-conflict context without exposing security version', async () => {
  const guard = guards();
  const handler = createTenantUserLifecycleHttpHandler({
    tenantUserLifecycleService: {
      async listUsers() {
        return { users: [], nextAfterId: null };
      },
      async setAccess() {
        throw new TenantUserLifecycleConflictError('TENANT_USER_LIFECYCLE_VERSION_CONFLICT', {
          currentVersion: 7,
        });
      },
    },
    principalGuard: guard.principalGuard,
    tenantGuard: guard.tenantGuard,
    maxBodyBytes: 4_096,
    maxResponseBytes: 32_768,
  });
  const body = JSON.stringify({ active: false, expectedVersion: 6 });
  await assert.rejects(
    handler({
      request: request('PUT', body),
      response: response(),
      parsedUrl: new URL(`/api/v1/tenant/users/${USER_ID}/access`, 'https://conference.example'),
      path: `/api/v1/tenant/users/${USER_ID}/access`,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError
      && error.statusCode === 409
      && error.context.currentVersion === 7,
  );
});

test('Tenant User lifecycle mutation propagates session-bound CSRF rejection before business logic', async () => {
  let mutationCalls = 0;
  const handler = createTenantUserLifecycleHttpHandler({
    tenantUserLifecycleService: {
      async listUsers() {
        return { users: [], nextAfterId: null };
      },
      async setAccess() {
        mutationCalls += 1;
      },
    },
    principalGuard: {
      async require(requestValue, options) {
        assert.equal(options.csrf, true);
        throw new ApiError(403, 'CSRF_INVALID');
      },
    },
    tenantGuard: {
      async requireKnown() {
        throw new Error('must not resolve Tenant after CSRF rejection');
      },
    },
    maxBodyBytes: 4_096,
    maxResponseBytes: 32_768,
  });
  const body = JSON.stringify({ active: false, expectedVersion: 1 });
  await assert.rejects(
    handler({
      request: request('PUT', body),
      response: response(),
      parsedUrl: new URL(`/api/v1/tenant/users/${USER_ID}/access`, 'https://conference.example'),
      path: `/api/v1/tenant/users/${USER_ID}/access`,
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError
      && error.statusCode === 403
      && error.code === 'CSRF_INVALID',
  );
  assert.equal(mutationCalls, 0);
});

test('Tenant audit route accepts only bounded canonical filters and delegates server Tenant authority', async () => {
  const guard = guards();
  let received;
  const handler = createTenantAuditQueryHttpHandler({
    tenantAuditQueryService: {
      async listEvents(values) {
        received = values;
        return {
          events: [],
          nextBeforeId: null,
          window: {
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-08-27T00:00:00.000Z',
          },
        };
      },
    },
    principalGuard: guard.principalGuard,
    tenantGuard: guard.tenantGuard,
    maxResponseBytes: 32_768,
  });
  const query = '?limit=20&beforeId=42&category=security&outcome=denied'
    + `&actorUserId=${USER_ID}&from=2026-08-01T00:00:00.000Z&to=2026-08-27T00:00:00.000Z`;
  assert.equal(await handler({
    request: request(),
    response: response(),
    parsedUrl: new URL(`/api/v1/audit${query}`, 'https://conference.example'),
    path: '/api/v1/audit',
    requestId: CORRELATION_ID,
  }), 200);
  assert.equal(received.tenantContext.tenantId, TENANT_ID);
  assert.equal(received.category, 'security');
  assert.equal(received.beforeId, '42');

  await assert.rejects(
    handler({
      request: request(),
      response: response(),
      parsedUrl: new URL(`/api/v1/audit?tenantId=${TENANT_ID}`, 'https://conference.example'),
      path: '/api/v1/audit',
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.statusCode === 400,
  );
  await assert.rejects(
    handler({
      request: request('GET', '{}'),
      response: response(),
      parsedUrl: new URL('/api/v1/audit', 'https://conference.example'),
      path: '/api/v1/audit',
      requestId: CORRELATION_ID,
    }),
    (error) => error instanceof ApiError && error.code === 'REQUEST_BODY_NOT_ALLOWED',
  );
});

test('capability view route is read-only and accepts no browser-selected authority or mutation', async () => {
  const guard = guards();
  const handler = createTenantCapabilityViewHttpHandler({
    tenantCapabilityViewService: {
      async getView({ tenantContext }) {
        assert.equal(tenantContext.tenantId, TENANT_ID);
        return { readOnly: true, tenantStatus: 'active', capabilities: [] };
      },
    },
    principalGuard: guard.principalGuard,
    tenantGuard: guard.tenantGuard,
    maxResponseBytes: 32_768,
  });
  assert.equal(await handler({
    request: request(),
    response: response(),
    parsedUrl: new URL('/api/v1/tenant/capabilities', 'https://conference.example'),
    path: '/api/v1/tenant/capabilities',
    requestId: CORRELATION_ID,
  }), 200);
  for (const context of [
    {
      request: request('PUT', JSON.stringify({ enabled: true })),
      parsedUrl: new URL('/api/v1/tenant/capabilities', 'https://conference.example'),
    },
    {
      request: request(),
      parsedUrl: new URL(`/api/v1/tenant/capabilities?tenantId=${TENANT_ID}`, 'https://conference.example'),
    },
    {
      request: request('GET', '{}'),
      parsedUrl: new URL('/api/v1/tenant/capabilities', 'https://conference.example'),
    },
  ]) {
    await assert.rejects(
      handler({
        ...context,
        response: response(),
        path: '/api/v1/tenant/capabilities',
        requestId: CORRELATION_ID,
      }),
      (error) => error instanceof ApiError && [400, 405].includes(error.statusCode),
    );
  }
});

test('all operational route families expose bounded defineRouteModule contracts', () => {
  assert.equal(tenantUserLifecycleRouteModule.id, 'tenant-user-lifecycle');
  assert.equal(tenantAuditQueryRouteModule.id, 'tenant-audit-query');
  assert.equal(tenantCapabilityViewRouteModule.id, 'tenant-capability-view');
});
