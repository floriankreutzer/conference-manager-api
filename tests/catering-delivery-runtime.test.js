import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../src/server.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
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


test('enabled delivery composes through the real server flat runtime bounds before persistence I/O', () => {
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000',
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' });
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  let reads = 0;
  const pool = { async query() { reads++; throw new Error('UNEXPECTED_PERSISTENCE'); },
    async connect() { reads++; throw new Error('UNEXPECTED_PERSISTENCE'); } };
  const modules = createCateringDeliveryRouteModules({ config, authorizationPolicy, auditService: audit.service,
    persistence: { pool, auditRepository: { async appendWithClient() { throw new Error('UNEXPECTED_AUDIT'); } } } });
  assert.deepEqual(modules.map((module) => module.id), ['catering-delivery-jobs','catering-manual-delivery','catering-order-versions']);
  const server = createHttpServer({ config, authorizationPolicy, auditService: audit.service, additionalRouteModules: modules,
    logger: { requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {} } });
  assert.equal(server.listening, false); assert.equal(reads, 0);
});
