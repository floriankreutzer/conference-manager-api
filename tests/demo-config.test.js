import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DemoConfigError,
  loadDemoCustomerConfig,
  loadDemoConfig,
  loadDemoPlatformConfig,
} from '../src/demo/config.js';

function validEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DEMO_RUNTIME: 'shared-postgres-v1',
    DEMO_SEED_VERSION: 'saas-3.5-shared-demo-v1',
    DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.invalid',
    DEMO_PLATFORM_ORIGIN: 'https://platform.demo.invalid',
    DEMO_CUSTOMER_DATABASE_URL:
      'postgres://demo_customer:customer-db-password@db.demo.invalid/conference_manager_demo_test',
    DEMO_PLATFORM_DATABASE_URL:
      'postgres://demo_platform:platform-db-password@db.demo.invalid/conference_manager_demo_test',
    DEMO_RESET_DATABASE_URL:
      'postgres://demo_reset:reset-db-password@db.demo.invalid/conference_manager_demo_test',
    DEMO_MIGRATION_DATABASE_URL:
      'postgres://demo_migrator:migration-db-password@db.demo.invalid/conference_manager_demo_test',
    DEMO_DATABASE_SSL: 'disable',
    DEMO_CUSTOMER_SESSION_SECRET: 'customer-session-secret-000000000001',
    DEMO_CUSTOMER_CSRF_SECRET: 'customer-csrf-secret-00000000000002',
    DEMO_PLATFORM_SESSION_SECRET: 'platform-session-secret-000000000001',
    DEMO_PLATFORM_CSRF_SECRET: 'platform-csrf-secret-00000000000002',
    DEMO_TENANT_AUDIT_HMAC_SECRET: 'tenant-audit-hmac-secret-000000000001',
    ...overrides,
  };
}

function configError(code) {
  return (error) => error instanceof DemoConfigError && error.code === code;
}

test('Demo config requires isolated origins, principals, secrets and one canonical database target', () => {
  const config = loadDemoConfig(validEnv({
    DEMO_CUSTOMER_DATABASE_URL:
      'postgres://demo_customer:customer-db-password@DB.demo.invalid/conference_manager_demo_test',
    DEMO_PLATFORM_DATABASE_URL:
      'postgres://demo_platform:platform-db-password@db.demo.invalid:5432/conference_manager_demo_test',
  }));
  assert.deepEqual(config.databaseTarget, {
    host: 'db.demo.invalid',
    port: '5432',
    database: 'conference_manager_demo_test',
  });
  assert.equal(config.databases.customer.role, 'demo_customer');
  assert.equal(config.databases.platform.role, 'demo_platform');
  assert.equal(config.databases.reset.role, 'demo_reset');
  assert.equal(config.databases.migration.role, 'demo_migrator');
  assert.equal(
    config.secrets.tenant_audit_hmac_secret,
    'tenant-audit-hmac-secret-000000000001',
  );
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.databases), true);
});

test('Demo config rejects Production, Pilot and real provider configuration', () => {
  assert.throws(
    () => loadDemoConfig(validEnv({ NODE_ENV: 'production' })),
    configError('DEMO_CONFIG_ENVIRONMENT_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ NODE_ENV: 'Pilot' })),
    configError('DEMO_CONFIG_ENVIRONMENT_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ AZURE_CLIENT_ID: 'real-provider-client' })),
    configError('DEMO_CONFIG_PRODUCTION_CONFIGURATION_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ MICROSOFT_GRAPH_URL: 'https://graph.microsoft.invalid' })),
    configError('DEMO_CONFIG_PRODUCTION_CONFIGURATION_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ AUDIT_HMAC_SECRET: 'production-audit-secret' })),
    configError('DEMO_CONFIG_PRODUCTION_CONFIGURATION_FORBIDDEN'),
  );
});

test('Demo config permits provider-named runner metadata that cannot configure the application', () => {
  const config = loadDemoConfig(validEnv({
    AZURE_HTTP_USER_AGENT: 'github-actions-runner',
    GITHUB_ACTION_REPOSITORY: 'actions/setup-node',
    RUNNER_ENVIRONMENT: 'github-hosted',
  }));

  assert.equal(config.environment, 'test');
});

test('Demo config rejects target mismatches and aliased database principals', () => {
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_PLATFORM_DATABASE_URL:
        'postgres://demo_platform:platform-db-password@other.demo.invalid/conference_manager_demo_test',
    })),
    configError('DEMO_CONFIG_DATABASE_TARGET_MISMATCH'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_PLATFORM_DATABASE_URL:
        'postgres://demo_customer:platform-db-password@db.demo.invalid/conference_manager_demo_test',
    })),
    configError('DEMO_CONFIG_DATABASE_PRINCIPAL_ALIAS_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_RESET_DATABASE_URL:
        'postgres://demo_reset:platform-db-password@db.demo.invalid/conference_manager_demo_test',
    })),
    configError('DEMO_CONFIG_DATABASE_PRINCIPAL_ALIAS_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_RESET_DATABASE_URL:
        'postgres://DemoReset:reset-db-password@db.demo.invalid/conference_manager_demo_test',
    })),
    configError('DEMO_CONFIG_DEMO_RESET_DATABASE_URL_INVALID'),
  );
});

test('Demo config rejects non-origin URLs, origin aliases and weak isolation secrets', () => {
  assert.throws(
    () => loadDemoConfig(validEnv({ DEMO_CUSTOMER_ORIGIN: 'http://customer.demo.invalid' })),
    configError('DEMO_CONFIG_DEMO_CUSTOMER_ORIGIN_INVALID'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.invalid/path' })),
    configError('DEMO_CONFIG_DEMO_CUSTOMER_ORIGIN_INVALID'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ DEMO_PLATFORM_ORIGIN: 'https://customer.demo.invalid' })),
    configError('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({ DEMO_TENANT_AUDIT_HMAC_SECRET: 'short' })),
    configError('DEMO_CONFIG_SECRET_TOO_SHORT'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_TENANT_AUDIT_HMAC_SECRET: 'customer-session-secret-000000000001',
    })),
    configError('DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoConfig(validEnv({
      DEMO_PLATFORM_CSRF_SECRET: 'customer-session-secret-000000000001',
    })),
    configError('DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN'),
  );
});

test('shared Demo mode requires verified database TLS', () => {
  assert.throws(
    () => loadDemoConfig(validEnv({ NODE_ENV: 'demo', DEMO_DATABASE_SSL: 'disable' })),
    configError('DEMO_CONFIG_DATABASE_SSL_INVALID'),
  );
  assert.equal(loadDemoConfig(validEnv({
    NODE_ENV: 'demo',
    DEMO_DATABASE_SSL: 'verify-full',
  })).databaseSsl, 'verify-full');
});

test('surface loaders reject credentials outside their process responsibility', () => {
  const customerEnv = validEnv();
  delete customerEnv.DEMO_PLATFORM_DATABASE_URL;
  delete customerEnv.DEMO_RESET_DATABASE_URL;
  delete customerEnv.DEMO_MIGRATION_DATABASE_URL;
  delete customerEnv.DEMO_PLATFORM_SESSION_SECRET;
  delete customerEnv.DEMO_PLATFORM_CSRF_SECRET;
  const customer = loadDemoCustomerConfig(customerEnv);
  assert.deepEqual(customer.origins, {
    customer: customerEnv.DEMO_CUSTOMER_ORIGIN,
    platform: customerEnv.DEMO_PLATFORM_ORIGIN,
  });
  assert.deepEqual(Object.keys(customer.databases), ['customer']);
  assert.deepEqual(Object.keys(customer.secrets).sort(), [
    'customer_csrf_secret',
    'customer_session_secret',
    'tenant_audit_hmac_secret',
  ]);
  assert.throws(
    () => loadDemoCustomerConfig({
      ...customerEnv,
      DEMO_MIGRATION_DATABASE_URL: validEnv().DEMO_MIGRATION_DATABASE_URL,
    }),
    configError('DEMO_CONFIG_EXCESS_CREDENTIAL_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoCustomerConfig({
      ...customerEnv,
      DEMO_PLATFORM_ORIGIN: customerEnv.DEMO_CUSTOMER_ORIGIN,
    }),
    configError('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN'),
  );

  const platformEnv = validEnv();
  delete platformEnv.DEMO_CUSTOMER_DATABASE_URL;
  delete platformEnv.DEMO_MIGRATION_DATABASE_URL;
  delete platformEnv.DEMO_CUSTOMER_SESSION_SECRET;
  delete platformEnv.DEMO_CUSTOMER_CSRF_SECRET;
  const platform = loadDemoPlatformConfig(platformEnv);
  assert.deepEqual(platform.origins, {
    customer: platformEnv.DEMO_CUSTOMER_ORIGIN,
    platform: platformEnv.DEMO_PLATFORM_ORIGIN,
  });
  assert.deepEqual(Object.keys(platform.databases).sort(), ['platform', 'reset']);
  assert.deepEqual(Object.keys(platform.secrets).sort(), [
    'platform_csrf_secret',
    'platform_session_secret',
    'tenant_audit_hmac_secret',
  ]);
  assert.throws(
    () => loadDemoPlatformConfig({
      ...platformEnv,
      DEMO_CUSTOMER_DATABASE_URL: validEnv().DEMO_CUSTOMER_DATABASE_URL,
    }),
    configError('DEMO_CONFIG_EXCESS_CREDENTIAL_FORBIDDEN'),
  );
  assert.throws(
    () => loadDemoPlatformConfig({
      ...platformEnv,
      DEMO_CUSTOMER_ORIGIN: platformEnv.DEMO_PLATFORM_ORIGIN,
    }),
    configError('DEMO_CONFIG_ORIGIN_ALIAS_FORBIDDEN'),
  );
});
