import assert from 'node:assert/strict';
import test from 'node:test';
import {
  architectureConsolidationBoundaryViolations,
  moduleBoundaryViolations,
} from '../scripts/check-module-boundaries.mjs';

test('Production and Demo compositions preserve isolated provider, session, and infrastructure boundaries', () => {
  const violations = architectureConsolidationBoundaryViolations({
    'src/index.js': "import './customer-composition.js';",
    'src/customer-composition.js': 'export const createCustomerComposition = () => null;',
    'src/server.js': 'export const createHttpServer = () => null;',
    'src/app.js': 'export const createApp = () => null;',
    'src/platform-main.js': [
      "import './platform-composition.js';",
      "import './platform-production-authentication.js';",
      'const env = process.env;',
    ].join('\n'),
    'src/platform-composition.js': 'export const createPlatformComposition = () => null;',
    'src/platform-production-authentication.js': [
      "import './platform/identity/entra-client.js';",
      'export const createProductionPlatformAuthentication = () => null;',
    ].join('\n'),
    'src/platform/identity/entra-client.js': 'export const createPlatformEntraClient = () => null;',
    'src/platform/index.js': 'export const createPlatformProcess = () => null;',
    'src/platform/app.js': 'export const createPlatformApp = () => null;',
    'src/demo/customer-main.js': [
      "import './customer-composition.js';",
      'const env = process.env;',
    ].join('\n'),
    'src/demo/customer-composition.js': [
      "import '../customer-composition.js';",
      "import './customer-server.js';",
    ].join('\n'),
    'src/demo/customer-server.js': "import '../app.js';",
    'src/demo/platform-main.js': [
      "import './platform-composition.js';",
      'const env = process.env;',
    ].join('\n'),
    'src/demo/platform-composition.js': [
      "import '../platform-composition.js';",
      "import './platform-server.js';",
    ].join('\n'),
    'src/demo/platform-server.js': "import '../platform/app.js';",
    'src/demo/provider/microsoft365-client.js': "import '../../integrations/microsoft365-contract.js';",
    'src/integrations/microsoft365-contract.js': 'export const providerContract = true;',
    'src/persistence/postgres/demo-reset-repository.js': [
      "import pg from 'pg';",
      "export const statement = 'SELECT seed_version FROM demo_runtime_metadata';",
    ].join('\n'),
    'src/demo/runtime-config.js': [
      'export const secrets = {',
      'customer_session_secret: true, customer_csrf_secret: true,',
      'platform_session_secret: true, platform_csrf_secret: true,',
      '};',
    ].join('\n'),
    'src/demo/config.js': "export const code = 'DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN';",
  });

  assert.deepEqual(violations, []);
});

test('Production composition fails when Demo code becomes directly or transitively reachable', () => {
  const violations = architectureConsolidationBoundaryViolations({
    'src/index.js': "import './customer-composition.js';",
    'src/customer-composition.js': "import './demo/fixture.js';",
    'src/demo/fixture.js': 'export const fixture = true;',
  });

  assert.ok(violations.some((item) => item.includes(
    'src/index.js -> src/customer-composition.js -> src/demo/fixture.js',
  )));
  assert.ok(violations.some((item) => item.startsWith(
    'src/customer-composition.js: Production composition must not reach the Demo runtime',
  )));
});

test('Demo code fails closed on real Microsoft identity and provider implementations', () => {
  const violations = architectureConsolidationBoundaryViolations({
    'src/demo/customer-main.js': "import '../identity/entra-client.js';",
    'src/demo/provider/microsoft365-client.js': "import '../../integrations/microsoft365-client.js';",
    'src/demo/platform-main.js': "import '../platform-production-authentication.js';",
    'src/identity/entra-client.js': 'export const realEntra = true;',
    'src/integrations/microsoft365-client.js': 'export const realGraph = true;',
    'src/platform-production-authentication.js': 'export const productionAuthentication = true;',
  });

  assert.equal(
    violations.filter((item) => item.includes(
      'Demo runtime must not import Production identity/provider implementation',
    )).length,
    3,
  );
});

test('customer and Platform Demo session/security dependencies cannot cross', () => {
  const violations = architectureConsolidationBoundaryViolations({
    'src/demo/identity/customer-persona-service.js': [
      "import '../../platform/identity/session-service.js';",
      "import './platform-persona-service.js';",
    ].join('\n'),
    'src/demo/identity/platform-persona-service.js': [
      "import '../../identity/session-service.js';",
      "import './customer-persona-service.js';",
    ].join('\n'),
    'src/platform/identity/session-service.js': 'export const platformSession = true;',
    'src/identity/session-service.js': 'export const customerSession = true;',
  });

  assert.ok(violations.some((item) => item.includes(
    'customer Demo security/session boundary must remain isolated',
  )));
  assert.ok(violations.some((item) => item.includes(
    'Platform Demo security/session boundary must remain isolated',
  )));
});

test('Demo configuration, PostgreSQL driver, and SQL authority are narrowly allowlisted', () => {
  const violations = architectureConsolidationBoundaryViolations({
    'src/demo/config.js': [
      "export const code = 'DEMO_CONFIG_SECRET_ALIAS_FORBIDDEN';",
      'export const env = process.env;',
    ].join('\n'),
    'src/demo/provider/unsafe-repository.js': [
      "import pg from 'pg';",
      "export const statement = 'DELETE FROM demo_runtime_metadata';",
    ].join('\n'),
  });

  assert.ok(violations.some((item) => item.includes(
    'process.env access is restricted to approved configuration and process entrypoints',
  )));
  assert.ok(violations.some((item) => item.includes(
    'the PostgreSQL driver is restricted to the PostgreSQL infrastructure boundary',
  )));
  assert.ok(violations.some((item) => item.includes(
    'SQL is restricted to the PostgreSQL infrastructure boundary',
  )));
});

test('the established policy admits the isolated Production auth root and Platform Demo surface', () => {
  const violations = moduleBoundaryViolations({
    'src/platform-production-authentication.js': "import './platform/identity/entra-client.js';",
    'src/platform/identity/entra-client.js': 'export const client = true;',
    'src/demo/platform-server.js': "import '../platform/app.js';",
    'src/platform/app.js': 'export const createPlatformApp = () => null;',
  });

  assert.deepEqual(violations, []);
});
