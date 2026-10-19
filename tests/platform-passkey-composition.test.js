import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPlatformConfig } from '../src/platform/config.js';
import { createProductionPlatformAuthentication } from '../src/platform-production-authentication.js';
import { createPlatformComposition } from '../src/platform-composition.js';

const directory = '11111111-1111-4111-8111-111111111111';
const application = '22222222-2222-4222-8222-222222222222';
function environment(overrides = {}) {
  return { NODE_ENV: 'development', PLATFORM_PUBLIC_ORIGIN: 'https://ops-int.example.com',
    PLATFORM_ENTRA_TENANT_ID: directory, PLATFORM_ENTRA_CLIENT_ID: application,
    PLATFORM_ENTRA_CLIENT_SECRET: 'a'.repeat(48), PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${directory}`,
    PLATFORM_OIDC_TRANSACTION_SECRET: 'b'.repeat(48), PLATFORM_CSRF_SECRET: 'c'.repeat(48),
    PLATFORM_AUDIT_HMAC_SECRET: 'd'.repeat(48), PLATFORM_CURSOR_SECRET: 'e'.repeat(48),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: 'f'.repeat(48), PLATFORM_PASSKEY_TRANSACTION_SECRET: 'g'.repeat(48),
    PLATFORM_ASSURANCE_MODE: 'passkey_setup', PLATFORM_SECURITY_EPOCH: '2',
    PLATFORM_DATABASE_URL: 'postgresql://synthetic-platform@localhost/platform', PLATFORM_DATABASE_SSL: 'disable', ...overrides };
}
function ports(config) {
  let queries = 0; let resolutions = 0; let current = null;
  const dependencies = { config,
    persistence: { pool: { async query() { queries++; throw new Error('UNEXPECTED_DATABASE_IO'); },
      async connect() { queries++; throw new Error('UNEXPECTED_DATABASE_IO'); } },
      auditRepository: { async appendWithClient() {} }, operatorRepository: { async findActiveByProviderIdentity() {} },
      oidcTransactionRepository: { async create() {}, async consume() {} } },
    platformAuditService: { async record() {}, createUnmappedAuthenticationFailure: value => value },
    platformSessionService: { async issue() {}, async rotate() {}, async revoke() {},
      async resolvePrincipal() { resolutions++; return current; }, verifyCsrf() { return true; } },
  };
  return { dependencies, queries: () => queries, resolutions: () => resolutions, setCurrent: value => { current = value; } };
}

test('CA remains the default; explicit application modes require isolated secrets, deployment and reviewed epoch', () => {
  const config = loadPlatformConfig(environment());
  assert.equal(config.assuranceMode, 'passkey_setup'); assert.equal(config.deploymentEnvironment, 'dev');
  assert.equal(config.authenticationMaxAgeSeconds, 300); assert.equal(config.oidcTransactionTtlSeconds, 300);
  assert.equal(config.mfaAuthenticationContext, null); assert.equal(config.stepUpAuthenticationContext, null);
  const legacy = loadPlatformConfig(environment({ PLATFORM_ASSURANCE_MODE: undefined, PLATFORM_PASSKEY_TRANSACTION_SECRET: undefined,
    PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'c1', PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT: 'c2' }));
  assert.equal(legacy.assuranceMode, 'conditional_access'); assert.equal(legacy.authenticationMaxAgeSeconds, 900);
  for (const [overrides, expected] of [
    [{ PLATFORM_ASSURANCE_MODE: 'unknown' }, 'PLATFORM_ASSURANCE_MODE_INVALID'],
    [{ PLATFORM_SECURITY_EPOCH: undefined }, 'PLATFORM_PASSKEY_EPOCH_CUTOVER_REQUIRED'],
    [{ PLATFORM_SECURITY_EPOCH: '1' }, 'PLATFORM_PASSKEY_EPOCH_CUTOVER_REQUIRED'],
    [{ NODE_ENV: 'test' }, 'PLATFORM_PASSKEY_DEPLOYMENT_ENVIRONMENT_REQUIRED'],
    [{ PLATFORM_PASSKEY_TRANSACTION_SECRET: undefined }, 'PLATFORM_PASSKEY_TRANSACTION_SECRET_REQUIRED'],
    [{ PLATFORM_PASSKEY_TRANSACTION_SECRET: 'b'.repeat(48) }, 'PLATFORM_PASSKEY_SECRET_ALIAS_FORBIDDEN'],
    [{ PLATFORM_PASSKEY_TRANSACTION_SECRET: 'c'.repeat(48) }, 'PLATFORM_PASSKEY_SECRET_ALIAS_FORBIDDEN'],
    [{ PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'c1' }, 'PLATFORM_PASSKEY_CA_CONTEXT_FORBIDDEN'],
    [{ PLATFORM_AUTHENTICATION_MAX_AGE_SECONDS: '60' }, 'PLATFORM_PASSKEY_PRIMARY_TTL_INVALID'],
    [{ PLATFORM_OIDC_TRANSACTION_TTL_SECONDS: '600' }, 'PLATFORM_PASSKEY_PRIMARY_TTL_INVALID'],
  ]) assert.throws(() => loadPlatformConfig(environment(overrides)), error => error.code === expected);
});

test('setup factory never resolves a business principal or weakens Microsoft primary into an assurance verifier', async () => {
  const config = loadPlatformConfig(environment()); const f = ports(config);
  const auth = createProductionPlatformAuthentication(f.dependencies);
  assert.equal(auth.platformPasskeyService.configuration().mode, 'passkey_setup');
  f.setCurrent({ assurance: { authenticationContext: 'cm:pk:v1' } });
  assert.equal(await auth.platformHttpSessionService.resolvePrincipal({}), null);
  assert.equal(f.resolutions(), 0); assert.equal(f.queries(), 0);
  assert.equal(typeof auth.start, 'function'); assert.equal(typeof auth.complete, 'function');
  assert.ok(auth.routeModules.some(module => module.id === 'platform-passkey-microsoft-authentication'));
  assert.ok(auth.routeModules.some(module => module.id === 'platform-passkey'));
  assert.equal(auth.routeModules.some(module => module.id === 'platform-authentication'), false);
  assert.throws(() => createProductionPlatformAuthentication({ ...f.dependencies, config: { ...config, securityEpoch: 1 } }),
    /COMPOSITION_CONFIGURATION_INVALID/);
});

test('active factory accepts only application-passkey sessions and composes all route families without I/O', async () => {
  const config = loadPlatformConfig(environment({ PLATFORM_ASSURANCE_MODE: 'application_passkey' })); const f = ports(config);
  const auth = createProductionPlatformAuthentication(f.dependencies);
  for (const context of ['c1','cm:pk:primary:v1',null]) {
    f.setCurrent({ assurance: { authenticationContext: context } });
    assert.equal(await auth.platformHttpSessionService.resolvePrincipal({}), null);
  }
  const current = { assurance: { authenticationContext: 'cm:pk:v1' } }; f.setCurrent(current);
  assert.equal(await auth.platformHttpSessionService.resolvePrincipal({}), current); assert.equal(f.queries(), 0);
  for (const mode of ['passkey_setup','application_passkey']) {
    const composition = createPlatformComposition({ config: loadPlatformConfig(environment({ PLATFORM_ASSURANCE_MODE: mode })),
      authenticationFactory: createProductionPlatformAuthentication });
    try { assert.equal(typeof composition.process.start, 'function'); }
    finally { await composition.stop(); }
  }
});
