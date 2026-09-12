import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDemoCustomerRuntimeConfig,
  createDemoPlatformRuntimeConfig,
} from '../src/demo/runtime-config.js';

const base = Object.freeze({
  runtime: 'shared-postgres-v1',
  seedVersion: 'saas-3.6-shared-demo-v2',
  origins: Object.freeze({
    customer: 'https://customer.demo.invalid',
    platform: 'https://platform.demo.invalid',
  }),
  databases: Object.freeze({
    customer: Object.freeze({ url: 'postgres://customer:password@db/demo' }),
    platform: Object.freeze({ url: 'postgres://platform:password@db/demo' }),
  }),
  databaseSsl: 'verify-full',
  secrets: Object.freeze({
    customer_session_secret: 'customer-session-secret-000000000001',
    customer_csrf_secret: 'customer-csrf-secret-00000000000002',
    platform_session_secret: 'platform-session-secret-000000000001',
    platform_csrf_secret: 'platform-csrf-secret-00000000000002',
    tenant_audit_hmac_secret: 'tenant-audit-hmac-secret-000000000001',
  }),
});

test('Demo runtime configs preserve one database target while separating security domains', () => {
  const customer = createDemoCustomerRuntimeConfig(base);
  const platform = createDemoPlatformRuntimeConfig(base);
  assert.equal(customer.mode, 'demo');
  assert.equal(platform.mode, 'demo');
  assert.equal(platform.identityMode, 'demo');
  assert.equal(customer.publicOrigin, base.origins.customer);
  assert.equal(platform.publicOrigin, base.origins.platform);
  assert.notEqual(customer.databaseUrl, platform.databaseUrl);
  assert.notEqual(customer.csrfSecret, platform.csrfSecret);
  assert.notEqual(customer.auditHmacSecret, platform.auditHmacSecret);
  assert.equal(customer.auditHmacSecret, base.secrets.tenant_audit_hmac_secret);
  assert.equal(platform.tenantAuditHmacSecret, base.secrets.tenant_audit_hmac_secret);
  assert.equal(customer.auditHmacSecret, platform.tenantAuditHmacSecret);
  assert.notEqual(platform.auditHmacSecret, platform.tenantAuditHmacSecret);
  assert.notEqual(platform.auditHmacSecret, platform.cursorSecret);
  assert.equal(customer.rateLimitMax, 120);
  assert.equal(platform.rateLimitMax, 120);
  assert.equal(customer.databaseStatementTimeoutMs, 10_000);
  assert.equal(platform.databaseStatementTimeoutMs, 10_000);
  assert.equal(platform.resetDatabaseStatementTimeoutMs, 60_000);
  assert.equal(customer.entraClientId, null);
  assert.equal(platform.entraClientId, null);
  assert.equal(Object.isFrozen(customer), true);
  assert.equal(Object.isFrozen(platform), true);
});

test('Demo reset timeout stays bounded without widening normal runtime statements', () => {
  const platform = createDemoPlatformRuntimeConfig(base);
  assert.equal(platform.databaseStatementTimeoutMs, 10_000);
  assert.equal(platform.resetDatabaseStatementTimeoutMs, 60_000);
  assert.equal(platform.resetDatabaseStatementTimeoutMs > platform.databaseStatementTimeoutMs, true);
  assert.equal(platform.resetDatabaseStatementTimeoutMs <= 60_000, true);
});

test('Demo runtime configs preserve a bounded explicit Demo request capacity', () => {
  const configured = Object.freeze({ ...base, rateLimitMax: 1000 });
  assert.equal(createDemoCustomerRuntimeConfig(configured).rateLimitMax, 1000);
  assert.equal(createDemoPlatformRuntimeConfig(configured).rateLimitMax, 1000);
});
