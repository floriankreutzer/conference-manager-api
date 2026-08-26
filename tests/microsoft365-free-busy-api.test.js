import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MICROSOFT365_ROUTES,
  createMicrosoft365HttpHandler,
  microsoft365RouteKey,
} from '../src/http/microsoft365-routes.js';

const PRINCIPAL = Object.freeze({ tenantId: 'tenant-a', userId: 'user-a' });
const TENANT_CONTEXT = Object.freeze({ tenantId: 'tenant-a', status: 'onboarding' });
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function request(method = 'POST', bodyChunks = []) {
  return {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of bodyChunks) yield Buffer.from(chunk);
    },
  };
}

function response() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    end(value = '') { this.body = value; },
    header(name) { return headers.get(name.toLowerCase()); },
  };
}

function handler({ csrfAccepted = true } = {}) {
  const guardCalls = [];
  const serviceCalls = [];
  return {
    guardCalls,
    serviceCalls,
    handle: createMicrosoft365HttpHandler({
      service: {
        async verifyFreeBusy(values) {
          serviceCalls.push(values);
          return { verified: true, checkedAt: '2026-08-26T06:00:00.000Z' };
        },
      },
      principalGuard: {
        async require(_request, options = {}) {
          guardCalls.push(options);
          if (options.csrf && !csrfAccepted) throw new Error('CSRF_REJECTED');
          return PRINCIPAL;
        },
      },
      tenantGuard: {
        async requireKnown(principal) {
          assert.equal(principal, PRINCIPAL);
          return TENANT_CONTEXT;
        },
      },
      maxBodyBytes: 65_536,
      maxResponseBytes: 65_536,
    }),
  };
}

async function call(handle, { method = 'POST', query = '', bodyChunks = [] } = {}) {
  const outgoing = response();
  const parsedUrl = new URL(`${MICROSOFT365_ROUTES.availabilityVerify}${query}`, 'https://conference.example');
  const status = await handle({
    request: request(method, bodyChunks),
    response: outgoing,
    parsedUrl,
    path: parsedUrl.pathname,
    requestId: REQUEST_ID,
  });
  return { status, outgoing };
}

test('free-busy verification route is explicit, CSRF-protected and response-minimized', async () => {
  assert.equal(
    microsoft365RouteKey(MICROSOFT365_ROUTES.availabilityVerify),
    'microsoft365_free_busy_verify',
  );
  const runtime = handler();
  const { status, outgoing } = await call(runtime.handle);
  assert.equal(status, 200);
  assert.deepEqual(runtime.guardCalls, [{ csrf: true }]);
  assert.equal(runtime.serviceCalls.length, 1);
  assert.equal(runtime.serviceCalls[0].principal, PRINCIPAL);
  assert.equal(runtime.serviceCalls[0].tenantContext, TENANT_CONTEXT);
  assert.equal(runtime.serviceCalls[0].correlationId, REQUEST_ID);
  const payload = JSON.parse(outgoing.body);
  assert.deepEqual(payload.verification, {
    verified: true,
    checkedAt: '2026-08-26T06:00:00.000Z',
  });
  assert.equal('tenantId' in payload, false);
  assert.equal('roomId' in payload, false);
});

test('free-busy verification rejects unsafe transport variations before provider work', async () => {
  const wrongMethod = handler();
  await assert.rejects(
    call(wrongMethod.handle, { method: 'GET' }),
    (error) => error?.statusCode === 405,
  );
  assert.equal(wrongMethod.serviceCalls.length, 0);

  const query = handler();
  await assert.rejects(
    call(query.handle, { query: '?tenantId=tenant-b' }),
    (error) => error?.statusCode === 400,
  );
  assert.equal(query.serviceCalls.length, 0);

  const body = handler();
  await assert.rejects(
    call(body.handle, { bodyChunks: ['{}'] }),
    (error) => error?.statusCode === 400,
  );
  assert.equal(body.serviceCalls.length, 0);

  const csrf = handler({ csrfAccepted: false });
  await assert.rejects(call(csrf.handle), /CSRF_REJECTED/);
  assert.equal(csrf.serviceCalls.length, 0);
});
