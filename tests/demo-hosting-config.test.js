import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DemoConfigError,
  loadDemoCustomerConfig,
  loadDemoPlatformConfig,
} from '../src/demo/config.js';
import {
  createDemoCustomerRuntimeConfig,
  createDemoPlatformRuntimeConfig,
} from '../src/demo/runtime-config.js';
import { createAnonymousGitEnvironment } from '../scripts/hosted-demo-git-environment.mjs';

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'demo',
    DEMO_RUNTIME: 'shared-postgres-v1',
    DEMO_SEED_VERSION: 'saas-3.5-shared-demo-v1',
    DEMO_CUSTOMER_ORIGIN: 'https://conference-manager-demo.onrender.com',
    DEMO_PLATFORM_ORIGIN: 'https://conference-manager-ops-demo.onrender.com',
    DEMO_DATABASE_SSL: 'verify-full',
    DEMO_LISTEN_HOST: '0.0.0.0',
    PORT: '10000',
    DEMO_STATIC_ROOT: '.demo-frontend',
    DEMO_TENANT_AUDIT_HMAC_SECRET: 'tenant-audit-hmac-secret-000000000001',
    ...overrides,
  };
}

function customerEnv(overrides = {}) {
  return baseEnv({
    DEMO_CUSTOMER_DATABASE_URL:
      'postgresql://cm_demo_customer:customer-db-password@db.demo.invalid/conference_manager_demo_shared',
    DEMO_CUSTOMER_SESSION_SECRET: 'customer-session-secret-000000000001',
    DEMO_CUSTOMER_CSRF_SECRET: 'customer-csrf-secret-00000000000002',
    ...overrides,
  });
}

function platformEnv(overrides = {}) {
  return baseEnv({
    DEMO_PLATFORM_DATABASE_URL:
      'postgresql://cm_demo_platform:platform-db-password@db.demo.invalid/conference_manager_demo_shared',
    DEMO_RESET_DATABASE_URL:
      'postgresql://cm_demo_reset:reset-db-password@db.demo.invalid/conference_manager_demo_shared',
    DEMO_PLATFORM_SESSION_SECRET: 'platform-session-secret-000000000001',
    DEMO_PLATFORM_CSRF_SECRET: 'platform-csrf-secret-00000000000002',
    ...overrides,
  });
}

function configError(code) {
  return (error) => error instanceof DemoConfigError && error.code === code;
}

test('hosted Customer and Platform Demo use Render listen values and the bounded static root', () => {
  const customer = createDemoCustomerRuntimeConfig(loadDemoCustomerConfig(customerEnv()));
  const platform = createDemoPlatformRuntimeConfig(loadDemoPlatformConfig(platformEnv()));

  for (const runtime of [customer, platform]) {
    assert.equal(runtime.host, '0.0.0.0');
    assert.equal(runtime.port, 10000);
    assert.equal(runtime.staticRoot, '.demo-frontend');
    assert.equal(runtime.databaseSsl, 'verify-full');
  }
  assert.equal(customer.publicOrigin, 'https://conference-manager-demo.onrender.com');
  assert.equal(platform.publicOrigin, 'https://conference-manager-ops-demo.onrender.com');
});

test('hosted Demo listen and static configuration fail closed', () => {
  for (const value of ['localhost', '0.0.0.1', '::', ' 0.0.0.0']) {
    assert.throws(
      () => loadDemoCustomerConfig(customerEnv({ DEMO_LISTEN_HOST: value })),
      configError('DEMO_CONFIG_LISTEN_HOST_INVALID'),
    );
  }
  for (const value of ['0', '65536', '10000.5', ' 10000']) {
    assert.throws(
      () => loadDemoCustomerConfig(customerEnv({ PORT: value })),
      configError('DEMO_CONFIG_PORT_INVALID'),
    );
  }
  for (const value of ['/tmp/frontend', '../frontend', 'frontend/../other', 'frontend\\other', '']) {
    assert.throws(
      () => loadDemoCustomerConfig(customerEnv({ DEMO_STATIC_ROOT: value })),
      configError('DEMO_CONFIG_STATIC_ROOT_INVALID'),
    );
  }
});

test('local/test Demo defaults remain unchanged when hosted settings are absent', () => {
  const env = customerEnv({
    NODE_ENV: 'test',
    DEMO_DATABASE_SSL: 'disable',
  });
  delete env.DEMO_LISTEN_HOST;
  delete env.PORT;
  delete env.DEMO_STATIC_ROOT;
  const runtime = createDemoCustomerRuntimeConfig(loadDemoCustomerConfig(env));
  assert.equal(runtime.host, '127.0.0.1');
  assert.equal(runtime.port, 3000);
  assert.equal(runtime.staticRoot, null);
});

test('hosted frontend fetch strips inherited Git and GitHub checkout credentials', () => {
  const environment = createAnonymousGitEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/render-home',
    SAFE_VALUE: 'preserved',
    GIT_ASKPASS: '/opt/render/askpass',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic inherited-credential',
    GITHUB_TOKEN: 'inherited-github-token',
    GH_TOKEN: 'inherited-gh-token',
    SSH_ASKPASS: '/opt/render/ssh-askpass',
  });

  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOME, '/tmp/render-home');
  assert.equal(environment.SAFE_VALUE, 'preserved');
  assert.equal(environment.GIT_ASKPASS, undefined);
  assert.equal(environment.GIT_CONFIG_KEY_0, undefined);
  assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.SSH_ASKPASS, undefined);
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0');
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_CONFIG_COUNT, '0');
  assert.equal(environment.GCM_INTERACTIVE, 'Never');
  assert.equal(typeof environment.GIT_CONFIG_GLOBAL, 'string');
  assert.equal(environment.GIT_CONFIG_GLOBAL.length > 0, true);
  assert.equal(Object.isFrozen(environment), true);
});

test('Render Blueprint keeps the operational Demo free, separate and manually deployed', async () => {
  const blueprint = await readFile(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /name: conference-manager-demo\n/);
  assert.match(blueprint, /name: conference-manager-ops-demo\n/);
  assert.equal((blueprint.match(/plan: free/g) || []).length, 2);
  assert.equal((blueprint.match(/region: frankfurt/g) || []).length, 2);
  assert.equal((blueprint.match(/autoDeployTrigger: off/g) || []).length, 2);
  assert.equal((blueprint.match(/DEMO_LISTEN_HOST/g) || []).length, 2);
  assert.equal((blueprint.match(/value: 0\.0\.0\.0/g) || []).length, 2);
  assert.equal((blueprint.match(/DEMO_STATIC_ROOT/g) || []).length, 2);
  assert.equal((blueprint.match(/fromGroup: conference-manager-demo-shared/g) || []).length, 2);
  assert.doesNotMatch(blueprint, /maxShutdownDelaySeconds/);
  assert.doesNotMatch(blueprint, /preDeployCommand/);
  assert.doesNotMatch(blueprint, /DEMO_MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(blueprint, /DATABASE_URL:/);
  assert.match(blueprint, /DEMO_CUSTOMER_DATABASE_URL\n\s+sync: false/);
  assert.match(blueprint, /DEMO_PLATFORM_DATABASE_URL\n\s+sync: false/);
  assert.match(blueprint, /DEMO_RESET_DATABASE_URL\n\s+sync: false/);

  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Prepare immutable hosted Demo browser artifacts/);
  assert.match(workflow, /DEMO_FRONTEND_REF="\$frontend_ref" npm run demo:hosted:prepare/);
  assert.match(workflow, /name: Resolve deployed immutable frontend ref/);
  assert.match(workflow, /ref: \$\{\{ steps\.frontend_ref\.outputs\.ref \}\}/);
  assert.doesNotMatch(workflow, /ref: 8bef6173f9a6c660e1d0062c430b01e6b44075fc/);

  const initialize = await readFile(
    new URL('../.github/workflows/hosted-demo-initialize.yml', import.meta.url),
    'utf8',
  );
  assert.match(initialize, /github\.ref == 'refs\/heads\/main'/);
  assert.match(initialize, /name: hosted-demo-initialize/);
  assert.match(initialize, /Require reviewed main ref/);
});
