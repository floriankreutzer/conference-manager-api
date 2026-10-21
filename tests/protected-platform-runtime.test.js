import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createProtectedPlatformRuntime } from '../src/protected-platform-runtime.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

function fixture(environment='int') {
  const database=new URL('postgresql://127.0.0.1:9/unavailable_fixture');
  database.username=`cm_protected_${environment}_platform`;database.password=Buffer.alloc(32,9).toString('base64url');
  return { NODE_ENV: 'production',PROTECTED_ENVIRONMENT: environment,PROTECTED_SECURITY_EPOCH: randomUUID(),
    PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),
    PROTECTED_CUSTOMER_ORIGIN: `https://app-${environment}.example.test`,
    PROTECTED_PLATFORM_ORIGIN: `https://ops-${environment}.example.com`,PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_PLATFORM_DATABASE_URL: database.href,PROTECTED_PLATFORM_ENTRA_TENANT_ID: randomUUID(),
    PROTECTED_PLATFORM_ENTRA_CLIENT_ID: randomUUID(),PROTECTED_PEER_ENTRA_CLIENT_ID: randomUUID(),
    PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),
    PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),
    PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]),
    PROTECTED_PLATFORM_ASSURANCE_MODE: 'application_passkey',PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@example.test' };
}

for (const environment of ['dev','int','prod']) {
  test(`owned ${environment} Platform process constructs pinned factories and exposes only lifecycle control`,async()=>{
    const env=fixture(environment),before={ ...env },runtime=await createProtectedPlatformRuntime(env);
    assert.deepEqual(Object.keys(runtime),['start','stop']);assert.ok(Object.isFrozen(runtime));assert.deepEqual(env,before);
    const stopping=runtime.stop();assert.equal(runtime.stop(),stopping);await stopping;
    await assert.rejects(runtime.start(),/PROTECTED_PLATFORM_RUNTIME_STATE_INVALID/);
  });
}

test('Platform setup profile and explicitly opted-in own synthetic profile construct separate closed runtime graphs',async()=>{
  for (const change of [{ PROTECTED_PLATFORM_ASSURANCE_MODE: 'passkey_setup' },
    { PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48),
      PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'i'.repeat(48),PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1' }]) {
    const runtime=await createProtectedPlatformRuntime({ ...fixture(),...change });await runtime.stop();
    assert.deepEqual(Object.keys(runtime),['start','stop']);
  }
});

test('Platform runtime refuses weak/foreign/replacement configuration without an issuer, driver or provider escape',async()=>{
  const env=fixture();
  for (const change of [{ PROTECTED_PLATFORM_ASSURANCE_MODE: 'conditional_access' },{ PROTECTED_PLATFORM_OWNER_RECIPIENT: '' },
    { PROTECTED_PLATFORM_VERIFIER: 'replace' },{ PROTECTED_CUSTOMER_CSRF_SECRET: 'PRIVATE_DETAIL' },
    { PROTECTED_PLATFORM_CSRF_SECRET: 'PRIVATE_DETAIL' },{ NODE_ENV: 'test' },{ PROTECTED_PLATFORM_PORT: '0' }]) {
    await assert.rejects(createProtectedPlatformRuntime({ ...env,...change }),
      { message: 'PROTECTED_PLATFORM_RUNTIME_CONFIGURATION_INVALID' });
  }
});

test('Platform unavailable actual loopback database and concurrent stop cannot grant a listener or restart',async()=>{
  const runtime=await createProtectedPlatformRuntime(fixture()),start=runtime.start(),stop=runtime.stop();
  await assert.rejects(start,{ message: 'PROTECTED_PLATFORM_RUNTIME_START_FAILED' });await stop;
  await assert.rejects(runtime.start(),/PROTECTED_PLATFORM_RUNTIME_STATE_INVALID/);await runtime.stop();
});

test('Platform process ownership remains isolated from Customer roots, lower layers and either closed Demo',()=>{
  for (const root of ['src/protected-platform-runtime.js','src/protected-platform-main.js']) {
    for (const source of ['src/protected-customer-runtime.js','src/index.js','src/domain/probe.js','src/application/probe.js',
      'src/http/probe.js','src/integrations/probe.js','src/demo/customer-main.js','src/demo/platform-main.js']) {
      assert.ok(moduleBoundaryViolations({ [source]: `import '../${root.split('/').at(-1)}';`,[root]: 'export const root=true;' })
        .length>0,source);
    }
  }
});
