import { loadDemoCustomerConfig, loadDemoPlatformConfig } from '../../src/demo/config.js';

export const DEMO_MEDIA_TEST_HOST = 'ep-demo-media-test.c-5.eu-central-1.aws.neon.tech';

// Synthetic parser fixtures only; no credential or endpoint here is used for I/O.
export function demoMediaStorageEnvironment(surface, mode = 'neon', overrides = {}) {
  const env = {
    NODE_ENV: 'demo',
    DEMO_RUNTIME: 'shared-postgres-v1',
    DEMO_SEED_VERSION: 'saas-3.7-three-demo-customers-v1',
    DEMO_CUSTOMER_ORIGIN: 'https://customer.demo.invalid',
    DEMO_PLATFORM_ORIGIN: 'https://platform.demo.invalid',
    DEMO_DATABASE_SSL: 'verify-full',
    DEMO_TENANT_AUDIT_HMAC_SECRET: 'synthetic-tenant-audit-secret-000000001',
    DEMO_MEDIA_STORAGE: mode,
  };
  const names = surface === 'customer' ? ['customer'] : ['platform', 'reset'];
  for (const name of names) {
    env[`DEMO_${name.toUpperCase()}_DATABASE_URL`]
      = `postgresql://cm_demo_${name}:synthetic-${name}-db@${DEMO_MEDIA_TEST_HOST}/conference_manager_demo_shared`;
  }
  env[`DEMO_${surface.toUpperCase()}_SESSION_SECRET`] = `synthetic-${surface}-session-secret-000000001`;
  env[`DEMO_${surface.toUpperCase()}_CSRF_SECRET`] = `synthetic-${surface}-csrf-secret-00000000002`;
  if (mode === 'neon') {
    env.DEMO_MEDIA_STORAGE_BRANCH_ID = 'br-demo-media-test';
    env.DEMO_MEDIA_STORAGE_DATABASE_HOST = DEMO_MEDIA_TEST_HOST;
    const scope = surface === 'customer' ? 'CUSTOMER' : 'RESET';
    env[`DEMO_${scope}_MEDIA_STORAGE_ACCESS_KEY_ID`] = `synthetic-${scope.toLowerCase()}-access-id`;
    env[`DEMO_${scope}_MEDIA_STORAGE_SECRET_ACCESS_KEY`] = `synthetic-${scope.toLowerCase()}-storage-secret-0001`;
  }
  return { ...env, ...overrides };
}

export function demoMediaStorageConfig(env, surface) {
  return surface === 'customer' ? loadDemoCustomerConfig(env) : loadDemoPlatformConfig(env);
}
