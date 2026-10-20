import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerEmailSourceKey } from '../src/identity/customer-email-source-key.js';

const configuration = { environment: 'int',secret: 'synthetic-customer-source-key-only-test-0000001' };
test('opaque socket fingerprints normalize address spelling and separate deployments and keys', () => {
  const key = createCustomerEmailSourceKey(configuration), first = key.fingerprint('192.0.2.1');
  assert.match(first,/^[a-f0-9]{64}$/);
  assert.equal(key.fingerprint('::ffff:192.0.2.1'),first); assert.equal(key.fingerprint('::FFFF:c000:201'),first);
  assert.equal(key.fingerprint('2001:0db8:0:0:0:0:0:1'),key.fingerprint('2001:db8::1'));
  assert.notEqual(key.fingerprint('192.0.2.2'),first);
  assert.notEqual(createCustomerEmailSourceKey({ ...configuration,environment: 'prod' }).fingerprint('192.0.2.1'),first);
  const otherKey = createCustomerEmailSourceKey({ ...configuration,secret: `${configuration.secret}-other` });
  assert.notEqual(otherKey.fingerprint('192.0.2.1'),first);
  assert.doesNotMatch(first,/192\.0\.2/);
});
test('forwarded lists, hostnames, ports, missing addresses and destroyed keys cannot choose a budget', () => {
  const key = createCustomerEmailSourceKey(configuration);
  for (const value of [null,'','example.com','192.0.2.1, 192.0.2.2','192.0.2.1:443','[2001:db8::1]','::1%lo','x'.repeat(46)]) {
    assert.throws(() => key.fingerprint(value),/ADDRESS_INVALID/);
  }
  key.destroy(); key.destroy(); assert.throws(() => key.fingerprint('192.0.2.1'),/UNAVAILABLE/);
});
