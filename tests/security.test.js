import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ApiError } from '../src/api-error.js';
import {
  assertSafeRequestTarget,
  createPrincipalGuard,
  createRateLimiter,
  readJsonObjectBody,
  validateExactObject,
} from '../src/security.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function requestBody(value, headers = {}) {
  const body = Buffer.from(value);
  const stream = Readable.from([body]);
  stream.headers = headers;
  return stream;
}

test('request target accepts only safe origin-form paths', () => {
  for (const target of [
    '/api/../secret',
    '/api/%2e%2e/secret',
    '/api/%2Fsecret',
    '/api\\secret',
    'https://attacker.example/api/v1/health/live',
    '//attacker.example/api/v1/health/live',
    '?probe=1',
  ]) {
    assert.throws(() => assertSafeRequestTarget(target), ApiError);
  }
  assert.doesNotThrow(() => assertSafeRequestTarget('/api/v1/health/live?probe=1'));
});

test('JSON body reader enforces content type, encoding, size, and object shape', async () => {
  const valid = requestBody('{"name":"Room"}', {
    'content-type': 'application/json; charset=utf-8',
    'content-length': '15',
  });
  assert.deepEqual(await readJsonObjectBody(valid, { maxBytes: 128 }), { name: 'Room' });

  await assert.rejects(
    readJsonObjectBody(requestBody('{}', { 'content-type': 'text/plain' }), { maxBytes: 128 }),
    (error) => error instanceof ApiError && error.code === 'UNSUPPORTED_MEDIA_TYPE',
  );
  await assert.rejects(
    readJsonObjectBody(requestBody('[]', { 'content-type': 'application/json' }), { maxBytes: 128 }),
    (error) => error instanceof ApiError && error.code === 'JSON_OBJECT_REQUIRED',
  );
  await assert.rejects(
    readJsonObjectBody(requestBody('{"value":"too-large"}', {
      'content-type': 'application/json',
      'content-length': '21',
    }), { maxBytes: 8 }),
    (error) => error instanceof ApiError && error.code === 'BODY_TOO_LARGE',
  );
});

test('positive object validation rejects missing, unknown, and invalid fields', () => {
  const schema = {
    required: { name: (value) => typeof value === 'string' && value.length >= 1 && value.length <= 80 },
    optional: { capacity: (value) => Number.isInteger(value) && value >= 1 && value <= 10_000 },
  };
  assert.deepEqual(validateExactObject({ name: 'Room A', capacity: 10 }, schema), { name: 'Room A', capacity: 10 });
  assert.throws(() => validateExactObject({ capacity: 10 }, schema), ApiError);
  assert.throws(() => validateExactObject({ name: 'Room A', admin: true }, schema), ApiError);
  assert.throws(() => validateExactObject({ name: '', capacity: -1 }, schema), ApiError);
});

test('principal guard validates server-side principal shape and CSRF for unsafe methods', async () => {
  const principal = { userId: USER_ID, tenantId: TENANT_ID, roles: ['employee', 'employee'] };
  const guard = createPrincipalGuard({
    resolvePrincipal: async () => principal,
    verifyCsrf: async () => true,
  });
  assert.deepEqual(await guard.require({ method: 'GET' }), {
    userId: USER_ID,
    tenantId: TENANT_ID,
    roles: ['employee'],
  });
  await assert.doesNotReject(guard.require({ method: 'POST' }, { csrf: true }));

  const denied = createPrincipalGuard({
    resolvePrincipal: async () => principal,
    verifyCsrf: async () => false,
  });
  await assert.rejects(denied.require({ method: 'POST' }, { csrf: true }), (error) => {
    return error instanceof ApiError && error.code === 'CSRF_INVALID';
  });

  const anonymous = createPrincipalGuard();
  await assert.rejects(anonymous.require({ method: 'GET' }), (error) => {
    return error instanceof ApiError && error.code === 'UNAUTHENTICATED';
  });
});

test('rate limiter is bounded and fails closed after the configured limit', () => {
  let now = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, maxKeys: 2, clock: () => now });
  limiter.consume('a');
  limiter.consume('a');
  assert.throws(() => limiter.consume('a'), (error) => error instanceof ApiError && error.code === 'RATE_LIMITED');
  limiter.consume('b');
  assert.throws(() => limiter.consume('c'), (error) => error instanceof ApiError && error.code === 'RATE_LIMITED');
  now = 1001;
  assert.doesNotThrow(() => limiter.consume('c'));
});
