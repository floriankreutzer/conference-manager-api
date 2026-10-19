import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDeploymentEnvironment } from '../src/deployment-environment.js';
import { ConfigurationError, loadConfig } from '../src/config.js';
import { PlatformConfigurationError, loadPlatformConfig } from '../src/platform/config.js';

test('deployment names retain the existing development, pilot and production security profiles', () => {
  for (const [mode, expected] of [
    ['development', 'dev'], ['pilot', 'int'], ['production', 'prod'], ['test', null],
  ]) {
    assert.equal(resolveDeploymentEnvironment(undefined, mode), expected);
    if (expected) assert.equal(resolveDeploymentEnvironment(expected, mode), expected);
  }
});

test('a deployment label cannot downgrade int or prod into a development or automated-test runtime', () => {
  for (const mode of ['development', 'test', 'pilot', 'production']) {
    for (const value of ['dev', 'int', 'prod']) {
      if (resolveDeploymentEnvironment(undefined, mode) === value) continue;
      assert.throws(() => resolveDeploymentEnvironment(value, mode), /DEPLOYMENT_ENVIRONMENT_MODE_MISMATCH/);
    }
  }
});

test('unknown, empty, alias and non-string deployment identifiers fail closed', () => {
  for (const value of ['', 'tes', 'demo', 'INT', 'production', null, {}, ['int'], 1]) {
    assert.throws(() => resolveDeploymentEnvironment(value, 'pilot'), /DEPLOYMENT_ENVIRONMENT_INVALID/);
  }
  assert.throws(() => resolveDeploymentEnvironment('int', 'demo'), /DEPLOYMENT_RUNTIME_MODE_INVALID/);
});

test('customer and operator loaders enforce the same deployment boundary before loading credentials', () => {
  for (const [load, ErrorClass] of [[loadConfig, ConfigurationError], [loadPlatformConfig, PlatformConfigurationError]]) {
    assert.throws(
      () => load({ NODE_ENV: 'development', DEPLOYMENT_ENVIRONMENT: 'int' }),
      (error) => error instanceof ErrorClass && error.code === 'DEPLOYMENT_ENVIRONMENT_MODE_MISMATCH',
    );
    assert.throws(
      () => load({ NODE_ENV: 'pilot', DEPLOYMENT_ENVIRONMENT: 'tes' }),
      (error) => error instanceof ErrorClass && error.code === 'DEPLOYMENT_ENVIRONMENT_INVALID',
    );
    const config = load({
      NODE_ENV: 'development', DEPLOYMENT_ENVIRONMENT: 'dev', PLATFORM_PUBLIC_ORIGIN: 'https://ops.example.com',
    });
    assert.equal(config.deploymentEnvironment, 'dev');
    assert.equal(config.mode, 'development');
  }
});

test('int and prod still require the production-like origin and identity configuration', () => {
  for (const [mode, environment] of [['pilot', 'int'], ['production', 'prod']]) {
    assert.throws(
      () => loadConfig({ NODE_ENV: mode, DEPLOYMENT_ENVIRONMENT: environment, PUBLIC_ORIGIN: 'http://example.com' }),
      (error) => error.code === 'PUBLIC_ORIGIN_HTTPS_REQUIRED',
    );
    assert.throws(
      () => loadPlatformConfig({ NODE_ENV: mode, DEPLOYMENT_ENVIRONMENT: environment,
        PLATFORM_PUBLIC_ORIGIN: 'https://ops.example.com' }),
      (error) => error.code === 'PLATFORM_ENTRA_TENANT_ID_REQUIRED',
    );
  }
});
