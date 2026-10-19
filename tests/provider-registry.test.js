import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderRegistry, normalizeProviderDescriptor } from '../src/integrations/provider-registry.js';

function descriptor(overrides = {}) {
  return {
    id: 'reference_caterer', runtime: 'production',
    capabilities: { 'catering.catalogue': 'api', 'catering.order': 'manual' },
    ...overrides,
  };
}

test('hybrid capabilities distinguish automated, manual and unsupported operations', () => {
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [descriptor()] });
  assert.equal(registry.capabilityMode('reference_caterer', 'catering.catalogue'), 'api');
  assert.equal(registry.capabilityMode('reference_caterer', 'catering.order'), 'manual');
  assert.equal(registry.capabilityMode('reference_caterer', 'catering.cancel'), 'unsupported');
  assert.equal(registry.requireMode('reference_caterer', 'catering.order', 'manual').id, 'reference_caterer');
  assert.throws(() => registry.requireMode('reference_caterer', 'catering.order', 'api'), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => registry.requireMode('reference_caterer', 'catering.cancel', 'manual'), /CAPABILITY_UNAVAILABLE/);
  assert.throws(() => registry.requireMode('reference_caterer', 'catering.cancel', 'unsupported'), /REQUIRED_MODE_INVALID/);
});

test('multiple provider families coexist without changing the calendar contract', () => {
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [
    descriptor(), descriptor({ id: 'reference_calendar', capabilities: { 'calendar.availability': 'api' } }),
  ] });
  assert.equal(registry.list().length, 2);
  assert.equal(registry.capabilityMode('reference_calendar', 'catering.order'), 'unsupported');
  assert.equal(registry.capabilityMode('reference_calendar', 'calendar.availability'), 'api');
});

test('registry snapshots and nested capabilities cannot be mutated through inputs or outputs', () => {
  const input = descriptor();
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [input] });
  input.capabilities['catering.order'] = 'api';
  input.id = 'changed_provider';
  assert.equal(registry.capabilityMode('reference_caterer', 'catering.order'), 'manual');
  assert.throws(() => { registry.get('reference_caterer').capabilities['catering.order'] = 'api'; }, TypeError);
  assert.throws(() => registry.list().pop(), TypeError);
  assert.throws(() => { registry.get = () => input; }, TypeError);
});

test('unknown provider/capability and duplicate registrations fail closed without input leakage', () => {
  const registry = createProviderRegistry({ runtime: 'production', descriptors: [descriptor()] });
  for (const id of ['unknown_provider', '__proto__', null, {}, 'https://untrusted.invalid']) {
    assert.throws(() => registry.get(id), { message: 'INTEGRATION_PROVIDER_UNKNOWN' });
  }
  for (const capability of ['catering.execute', '__proto__', null, {}]) {
    assert.throws(() => registry.capabilityMode('reference_caterer', capability), /CAPABILITY_INVALID/);
  }
  assert.throws(() => createProviderRegistry({ runtime: 'production', descriptors: [descriptor(), descriptor()] }), /DUPLICATE/);
});

test('Demo and Production descriptors cannot be mixed or used as fallback', () => {
  for (const [runtime, sourceRuntime] of [['production', 'demo'], ['demo', 'production']]) {
    assert.throws(() => createProviderRegistry({ runtime, descriptors: [descriptor({ runtime: sourceRuntime })] }), /MISMATCH/);
  }
  const demo = createProviderRegistry({ runtime: 'demo', descriptors: [descriptor({ runtime: 'demo' })] });
  assert.equal(demo.get('reference_caterer').runtime, 'demo');
});

test('closed descriptor schemas reject credentials, URLs, authority fields and malformed capabilities', () => {
  for (const key of ['endpoint', 'credentials', 'secretReference', 'tenantId', 'roles', 'factory']) {
    assert.throws(() => normalizeProviderDescriptor({ ...descriptor(), [key]: 'untrusted-value' }), /DESCRIPTOR_INVALID/);
  }
  for (const capabilities of [null, [], {}, { 'catering.order': true }, { arbitrary: 'api' }, { 'catering.order': 'API' }]) {
    assert.throws(() => normalizeProviderDescriptor(descriptor({ capabilities })), TypeError);
  }
  for (const id of ['', 'a', 'A_provider', 'provider-name', 'x'.repeat(49), 'https://untrusted.invalid']) {
    assert.throws(() => normalizeProviderDescriptor(descriptor({ id })), /PROVIDER_ID_INVALID/);
  }
  for (const runtime of [null, 'pilot', 'Production', true]) {
    assert.throws(() => normalizeProviderDescriptor(descriptor({ runtime })), /RUNTIME_INVALID/);
  }
});

test('inherited properties, accessors and symbol properties cannot smuggle registration metadata', () => {
  assert.throws(() => normalizeProviderDescriptor(Object.create(descriptor())), /DESCRIPTOR_INVALID/);
  let calls = 0;
  const input = descriptor();
  Object.defineProperty(input, 'id', { enumerable: true, get() { calls += 1; return 'unsafe_provider'; } });
  assert.throws(() => normalizeProviderDescriptor(input), /DESCRIPTOR_INVALID/);
  assert.equal(calls, 0);
  assert.throws(() => normalizeProviderDescriptor({ ...descriptor(), [Symbol('hidden')]: true }), /DESCRIPTOR_INVALID/);
  const hidden = descriptor();
  Object.defineProperty(hidden, 'secretReference', { value: 'hidden' });
  assert.throws(() => normalizeProviderDescriptor(hidden), /DESCRIPTOR_INVALID/);
  const capabilities = { 'catering.order': 'manual' };
  Object.defineProperty(capabilities, 'catering.status', { enumerable: true, get() { calls += 1; return 'api'; } });
  assert.throws(() => normalizeProviderDescriptor(descriptor({ capabilities })), /CAPABILITIES_INVALID/);
  assert.equal(calls, 0);
});

test('bounded registry accepts an empty deployment and rejects excess, missing or invalid configuration', () => {
  assert.deepEqual(createProviderRegistry({ runtime: 'production', descriptors: [] }).list(), []);
  for (const config of [undefined, {}, { runtime: 'production' }, { runtime: 'production', descriptors: {} }]) {
    assert.throws(() => createProviderRegistry(config), TypeError);
  }
  const descriptors = Array.from({ length: 32 }, (_, i) => descriptor({ id: `provider_${i}` }));
  assert.equal(createProviderRegistry({ runtime: 'production', descriptors }).list().length, 32);
  descriptors.push(descriptor({ id: 'provider_extra' }));
  assert.throws(() => createProviderRegistry({ runtime: 'production', descriptors }), /REGISTRY_INVALID/);
});
