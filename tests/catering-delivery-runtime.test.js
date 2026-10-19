import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { cateringDeliveryEnabled, cateringOrdersEnabled, loadFeatureFlags } from '../src/feature-flags.js';
import { createCateringDeliveryRouteModules } from '../src/catering-delivery-composition.js';

test('delivery rollout is strict, defaults off and requires the independent order foundation', () => {
  assert.equal(cateringDeliveryEnabled(), false);
  assert.equal(cateringDeliveryEnabled({ 'catering.configuration': true }), false);
  assert.equal(cateringDeliveryEnabled({ 'catering.configuration': false, 'catering.orders': true }), false);
  assert.equal(cateringOrdersEnabled(loadFeatureFlags({ CATERING_ORDERS_ENABLED: 'true' })), true);
  assert.equal(cateringDeliveryEnabled(loadFeatureFlags({ CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' })), true);
  assert.throws(() => loadFeatureFlags({ CATERING_DELIVERY_ENABLED: 'true' }), /ORDERS_REQUIRED/);
  for (const value of ['',true,false,1,null,'TRUE','1',' true ']) {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', CATERING_DELIVERY_ENABLED: value }), /DELIVERY_ENABLED_INVALID/);
  }
  assert.throws(() => cateringDeliveryEnabled({ 'catering.configuration': false, 'catering.delivery': true }), /FEATURE_FLAGS_INVALID/);
  let reads = 0;
  const accessor = Object.defineProperty({ 'catering.configuration': false }, 'catering.delivery', {
    enumerable: true, get() { reads++; return true; } });
  assert.throws(() => cateringDeliveryEnabled(accessor), /FEATURE_FLAGS_INVALID/); assert.equal(reads, 0);
});

test('disabled delivery does not touch persistence or activate history; enabled composition refuses Demo', () => {
  const persistence = new Proxy({}, { get() { throw new Error('PERSISTENCE_ACCESSED'); } });
  assert.deepEqual(createCateringDeliveryRouteModules({ config: {}, persistence }), []);
  const featureFlags = loadFeatureFlags({ CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  assert.throws(() => createCateringDeliveryRouteModules({ config: { featureFlags } }), /PERSISTENCE_REQUIRED/);
  assert.throws(() => createCateringDeliveryRouteModules({ config: { featureFlags, demoRuntime: true } }), /DEMO_NOT_SUPPORTED/);
});
