import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPlatformMethod,
  assertPlatformRequestOrigin,
  isPlatformUnsafeMethod,
} from '../src/platform/http/security.js';

const ORIGIN = 'https://platform.demo.invalid';

test('Platform PUT is bounded to the same unsafe-request origin policy as other mutations', () => {
  assert.doesNotThrow(() => assertPlatformMethod('PUT'));
  assert.equal(isPlatformUnsafeMethod('PUT'), true);
  assert.throws(
    () => assertPlatformRequestOrigin({}, ORIGIN, { required: isPlatformUnsafeMethod('PUT') }),
    (error) => error.statusCode === 403 && error.code === 'PLATFORM_ORIGIN_NOT_ALLOWED',
  );
  assert.throws(
    () => assertPlatformRequestOrigin({ origin: 'https://attacker.invalid' }, ORIGIN, { required: true }),
    (error) => error.statusCode === 403 && error.code === 'PLATFORM_ORIGIN_NOT_ALLOWED',
  );
  assert.doesNotThrow(() => assertPlatformRequestOrigin({ origin: ORIGIN }, ORIGIN, { required: true }));
});
