import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createProtectedPlatformAuthentication } from '../src/platform-production-authentication.js';
import { deriveProtectedAuthenticationFlowSecret } from '../src/identity/protected-authentication-flow-secret.js';

function environment(change={}) {
  const directory='11111111-1111-4111-8111-111111111111';
  return { NODE_ENV: 'pilot',DEPLOYMENT_ENVIRONMENT: 'int',PLATFORM_PUBLIC_ORIGIN: 'https://ops-int.example.com',
    PLATFORM_SERVICE_VERSION: '0.1.0',PLATFORM_BUILD_ID: 'protected-auth-fixture',
    PLATFORM_ENTRA_TENANT_ID: directory,PLATFORM_ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PLATFORM_ENTRA_AUTHORITY: `https://login.microsoftonline.com/${directory}`,
    PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),PLATFORM_CSRF_SECRET: 'c'.repeat(48),
    PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),PLATFORM_CURSOR_SECRET: 'u'.repeat(48),
    PLATFORM_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),
    PLATFORM_ASSURANCE_MODE: 'application_passkey',PLATFORM_SECURITY_EPOCH: '7',
    PLATFORM_DATABASE_URL: 'postgresql://synthetic-platform@localhost/platform',PLATFORM_DATABASE_SSL: 'verify-full',...change };
}
function pools() {
  let business=0,leases=0;
  const pool={ async query() { business++;throw new Error('UNEXPECTED_BUSINESS_READ'); },
    async connect() { business++;throw new Error('UNEXPECTED_BUSINESS_CONNECT'); } };
  const leasePool={ async query() { assert.fail('DIRECT_LEASE_QUERY'); },async connect() {
    leases++;return { async query(input) { return typeof input==='object' && input.text.includes('pg_try_advisory')
      ? { rowCount: 1,rows: [{ acquired: true }] } : { rowCount: 0,rows: [] }; },release() {} };
  } };
  return { pool,leasePool,business: ()=>business,leases: ()=>leases };
}

test('owned Platform auth has no process/issuer; normal entries reject stale UUID before business work',async()=>{
  const f=pools(),owned=createProtectedPlatformAuthentication({ ...f,env: environment(),protectedSecurityEpoch: randomUUID() });
  assert.equal(f.business(),0);assert.equal(f.leases(),0);
  assert.deepEqual(owned.routeModules.map(module=>module.id),['platform-passkey-microsoft-authentication','platform-passkey']);
  assert.equal(owned.platformHttpSessionService.issue,undefined);assert.equal(owned.platformHttpSessionService.rotate,undefined);
  assert.equal(owned.platformPasskeyService.configuration().minimumPasskeys,2);
  for (const work of [()=>owned.start(),()=>owned.complete({}),()=>owned.platformPasskeyService.pendingAuthentication('invalid'),
    ()=>owned.platformHttpSessionService.resolvePrincipal({}),()=>owned.normalPasskeyService.startLogin('untrusted'),
    ()=>owned.syntheticPasskeyService.startStepUp({},{}),()=>owned.withPreparationScope(()=>assert.fail('STALE_WORK'))]) {
    await assert.rejects(work(),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  }
  assert.equal(f.business(),0);assert.equal(f.leases(),7);
});

test('owned factory fixes parsed profile, independent secrets, distinct pools and UUID; PROD has no synthetic proof',()=>{
  const f=pools(),epoch=randomUUID(),options={ ...f,env: environment(),protectedSecurityEpoch: epoch };
  assert.equal(createProtectedPlatformAuthentication({ ...options,
    env: environment({ NODE_ENV: 'production',DEPLOYMENT_ENVIRONMENT: 'prod' }) })
    .syntheticPasskeyService,null);
  for (const change of [{ protectedSecurityEpoch: 'invalid' },{ leasePool: f.pool },
    { env: environment({ PLATFORM_PASSKEY_TRANSACTION_SECRET: 'o'.repeat(48) }) },
    { env: environment({ PLATFORM_SECURITY_EPOCH: '1' }) },
    { env: environment({ PLATFORM_ASSURANCE_MODE: 'conditional_access',PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'c1',
      PLATFORM_ENTRA_STEP_UP_AUTHENTICATION_CONTEXT: 'c2' }) }]) {
    assert.throws(()=>createProtectedPlatformAuthentication({ ...options,...change }));
  }
  const setup=createProtectedPlatformAuthentication({ ...options,env: environment({ PLATFORM_ASSURANCE_MODE: 'passkey_setup' }) });
  assert.equal(setup.syntheticPasskeyService,null);
  assert.equal(f.business(),0);assert.equal(f.leases(),0);
});

test('both Platform pending purposes separate epoch/environment and every Customer purpose without changing accepted KDF bytes',()=>{
  const scope={ secret: 's'.repeat(48),environment: 'int',securityEpoch: randomUUID() };
  const purposes=['customer-email-flow','customer-email-code','customer-microsoft-flow','platform-passkey-flow','platform-microsoft-flow'];
  const keys=purposes.map(purpose=>deriveProtectedAuthenticationFlowSecret({ ...scope,purpose }));
  assert.equal(new Set(keys).size,purposes.length);
  for (const purpose of purposes.slice(3)) {
    const old=deriveProtectedAuthenticationFlowSecret({ ...scope,purpose });
    for (const change of [{ environment: 'dev' },{ environment: 'prod' },{ securityEpoch: randomUUID() }]) {
      assert.notEqual(old,deriveProtectedAuthenticationFlowSecret({ ...scope,purpose,...change }));
    }
    assert.equal(old,deriveProtectedAuthenticationFlowSecret({ ...scope,purpose,securityEpoch: scope.securityEpoch.toUpperCase() }));
  }
});
