import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadProtectedPlatformConfiguration } from '../src/protected-platform-config.js';
import { loadProtectedCustomerConfiguration } from '../src/protected-customer-config.js';
import { createProtectedPlatformAuthentication } from '../src/platform-production-authentication.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const CUSTOMER='11111111-1111-4111-8111-111111111111',PLATFORM='22222222-2222-4222-8222-222222222222';
function common(environment='int',surface='platform') {
  const database=new URL('postgresql://db.example.test/neondb');
  database.username=`cm_protected_${environment}_${surface}`;database.password=Buffer.alloc(32,9).toString('base64url');
  return { NODE_ENV: 'production',PROTECTED_ENVIRONMENT: environment,PROTECTED_SECURITY_EPOCH: randomUUID(),
    PROTECTED_CUSTOMER_ORIGIN: `https://app-${environment}.example.test`,
    PROTECTED_PLATFORM_ORIGIN: `https://ops-${environment}.example.test`,
    PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_PLATFORM_SECURITY_EPOCH: '7',
    PROTECTED_PEER_ENTRA_CLIENT_ID: surface==='platform' ? CUSTOMER : PLATFORM,
    [`PROTECTED_${surface.toUpperCase()}_DATABASE_URL`]: database.href,PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 't'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
}
function fixture(environment='int') {
  return { ...common(environment),PROTECTED_PLATFORM_ENTRA_TENANT_ID: randomUUID(),PROTECTED_PLATFORM_ENTRA_CLIENT_ID: PLATFORM,
    PROTECTED_PLATFORM_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PROTECTED_PLATFORM_OIDC_TRANSACTION_SECRET: 'o'.repeat(48),
    PROTECTED_PLATFORM_CSRF_SECRET: 'c'.repeat(48),PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'a'.repeat(48),
    PROTECTED_PLATFORM_CURSOR_SECRET: 'u'.repeat(48),PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET: 'p'.repeat(48),
    PROTECTED_PLATFORM_ASSURANCE_MODE: 'application_passkey',PROTECTED_PLATFORM_OWNER_RECIPIENT: 'Owner@EXAMPLE.test' };
}
function load(t,env) { const result=loadProtectedPlatformConfiguration(env);t.after(()=>result.cipher.destroy());return result; }
function noIo() {
  return { query() { assert.fail('NO_CONSTRUCTION_DATABASE_ACCESS'); },connect() { assert.fail('NO_CONSTRUCTION_CONNECT'); } };
}

test('INT audit segment is bound only by the owned profile and cannot configure another environment',t=>{
  const env=fixture('int'),id=randomUUID(),bundle=load(t,{ ...env,PROTECTED_PLATFORM_AUDIT_SEGMENT_ID: id });
  assert.deepEqual(bundle.config.auditSegment,{ id,environment: 'int',deploymentEpoch: env.PROTECTED_SECURITY_EPOCH });
  for (const environment of ['dev','prod']) {
    assert.throws(()=>loadProtectedPlatformConfiguration({ ...fixture(environment),PROTECTED_PLATFORM_AUDIT_SEGMENT_ID: id }),
      /AUDIT_SEGMENT_INVALID/);
  }
  assert.throws(()=>loadProtectedPlatformConfiguration({ ...env,PROTECTED_PLATFORM_AUDIT_SEGMENT_ID: 'not-a-segment' }),
    /AUDIT_SEGMENT_INVALID/);
});

for (const environment of ['dev','int','prod']) {
  test(`${environment} Operations retain production security, explicit passkey profile and exact owned authentication namespace`,t=>{
    const env=fixture(environment),before={ ...env },inherited=Object.keys(process.env),bundle=load(t,env);
    assert.deepEqual(env,before);assert.deepEqual(Object.keys(process.env),inherited);
    assert.equal(bundle.config.mode,'production');assert.equal(bundle.config.deploymentEnvironment,environment);
    assert.equal(bundle.config.databaseSsl,'verify-full');assert.equal(bundle.config.securityEpoch,7);
    assert.equal(bundle.config.authenticationMaxAgeSeconds,300);assert.equal(bundle.config.oidcTransactionTtlSeconds,300);
    assert.equal(bundle.config.assuranceMode,'application_passkey');assert.equal(bundle.ownerRecipient,'Owner@example.test');
    assert.equal(bundle.ownerLocale,'de');assert.equal(bundle.synthetic,null);
    assert.ok(Object.isFrozen(bundle));assert.equal(bundle.authenticationEnvironment,undefined);
    const owned=bundle.authenticationFactory({ pool: noIo(),leasePool: noIo() });
    assert.deepEqual(owned.platformPasskeyService.configuration(),{ mode: 'application_passkey',environment,minimumPasskeys: 2 });
    assert.equal(owned.platformHttpSessionService.issue,undefined);
    if (environment==='prod') assert.equal(owned.syntheticPasskeyService,null);
  });
}

test('Operations configuration rejects default/CA assurance, unknown input, missing owner and aliased identity/secrets without reflection',
t=>{
  const env=fixture();
  for (const key of ['PROTECTED_PLATFORM_ASSURANCE_MODE','PROTECTED_PLATFORM_OWNER_RECIPIENT',
    'PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET','PROTECTED_CUSTODY_KEYRING']) {
    const changed={ ...env };delete changed[key];assert.throws(()=>loadProtectedPlatformConfiguration(changed));
  }
  for (const changed of [{ PROTECTED_PLATFORM_ASSURANCE_MODE: 'conditional_access' },{ PROTECTED_PLATFORM_ASSURANCE_MODE: 'unknown' },
    { PROTECTED_PLATFORM_ENTRA_CLIENT_ID: CUSTOMER },{ PROTECTED_PLATFORM_PASSKEY_TRANSACTION_SECRET: env.PROTECTED_PLATFORM_CSRF_SECRET },
    { PROTECTED_PLATFORM_OWNER_RECIPIENT: 'invalid' },{ PROTECTED_PLATFORM_OWNER_LOCALE: 'fr' },
    { PROTECTED_PLATFORM_EXTRA_ISSUER: 'true' },{ PROTECTED_CUSTOMER_CSRF_SECRET: 'private-customer-value' },
    { PROTECTED_PLATFORM_ENTRA_MFA_AUTHENTICATION_CONTEXT: 'c1' },{ PROTECTED_PLATFORM_SECURITY_EPOCH: '1' },
    { PROTECTED_PLATFORM_HOST: 'remote.invalid' },{ PROTECTED_PLATFORM_SESSION_TTL_SECONDS: '999999' }]) {
    assert.throws(()=>loadProtectedPlatformConfiguration({ ...env,...changed }),error=>{
      for (const value of Object.values(changed).filter(value=>value.length>20)) assert.equal(error.message.includes(value),false);
      return true;
    });
  }
  const setup=load(t,{ ...env,PROTECTED_PLATFORM_ASSURANCE_MODE: 'passkey_setup' });
  assert.equal(setup.config.assuranceMode,'passkey_setup');
  const accessor=Object.defineProperty({ ...env },'PROTECTED_PLATFORM_CSRF_SECRET',
    { get() { return assert.fail('CONFIGURATION_GETTER'); } });
  assert.throws(()=>loadProtectedPlatformConfiguration(accessor),/VALUE_INVALID/);
});

test('synthetic Operations need explicit active DEV/INT assurance and two distinct handoff purpose inputs',t=>{
  const env=fixture(),enabled={ ...env,PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48),
    PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'i'.repeat(48) };
  assert.equal(load(t,enabled).synthetic.intentSecret,'i'.repeat(48));
  for (const changed of [{ PROTECTED_PLATFORM_ASSURANCE_MODE: 'passkey_setup' },
    { PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: enabled.PROTECTED_HANDOFF_SECRET },{ PROTECTED_SYNTHETIC_ENABLED: 'false' }]) {
    assert.throws(()=>loadProtectedPlatformConfiguration({ ...enabled,...changed }));
  }
  assert.throws(()=>loadProtectedPlatformConfiguration({ ...fixture('prod'),PROTECTED_SYNTHETIC_ENABLED: 'true',
    PROTECTED_HANDOFF_SECRET: 'h'.repeat(48),PROTECTED_PLATFORM_HANDOFF_INTENT_SECRET: 'i'.repeat(48) }),/SYNTHETIC_INVALID/);
});

test('surface ciphertext custody interoperates without sharing any Platform authentication or audit secret',t=>{
  const platform=load(t,fixture()),customerEnv={ ...common('int','customer'),PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: CUSTOMER,
    PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'j'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'k'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48) };
  const customer=loadProtectedCustomerConfiguration(customerEnv);t.after(()=>customer.cipher.destroy());
  const scope={ environment: 'int',mailboxId: randomUUID(),recordId: randomUUID(),tenantId: null,purpose: 'mailbox_recipient' };
  const bytes=Buffer.from('Synthetic@example.test'),sealed=platform.cipher.seal(bytes,scope),opened=customer.cipher.open(sealed,scope);
  try { assert.deepEqual(opened,bytes); } finally { opened.fill(0);bytes.fill(0); }
  assert.equal(platform.cipher.recipientLookup('Synthetic@example.test'),customer.cipher.recipientLookup('Synthetic@example.test'));
  assert.equal(customer.config.auditHmacSecret,platform.config.tenantAuditHmacSecret);
  assert.notEqual(customer.config.auditHmacSecret,platform.config.auditHmacSecret);
  assert.equal(customerEnv.PROTECTED_PLATFORM_AUDIT_HMAC_SECRET,undefined);
});

test('explicit production namespace mapping cannot override a weak or contradictory canonical environment',t=>{
  const bundle=load(t,fixture());
  for (const change of [{ protectedEnvironment: 'demo' },{ env: { NODE_ENV: 'pilot' } },
    { env: { NODE_ENV: 'production',DEPLOYMENT_ENVIRONMENT: 'prod' } }]) {
    assert.throws(()=>createProtectedPlatformAuthentication({ env: { NODE_ENV: 'production' },pool: noIo(),leasePool: noIo(),
      protectedSecurityEpoch: bundle.profile.securityEpoch,protectedEnvironment: 'int',...change }),/ENVIRONMENT_CONFIGURATION_INVALID/);
  }
  for (const context of [{ pool: noIo() },{ pool: noIo(),leasePool: noIo(),env: {} },
    { get pool() { return assert.fail('AUTHENTICATION_CONTEXT_GETTER'); },leasePool: noIo() }]) {
    assert.throws(()=>bundle.authenticationFactory(context),/AUTHENTICATION_CONTEXT_INVALID/);
  }
});

test('only the explicit Operations config root crosses its config boundary; Customer/HTTP/lower/Demo consumers stay denied',()=>{
  const root='src/protected-platform-config.js';
  for (const source of ['src/customer-composition.js','src/domain/probe.js','src/application/probe.js','src/http/probe.js',
    'src/integrations/probe.js','src/demo/customer-main.js','src/demo/platform-main.js']) {
    const relative=source==='src/customer-composition.js' ? './' : '../';
    assert.ok(moduleBoundaryViolations({ [source]: `import '${relative}protected-platform-config.js';`,
      [root]: 'export const config=true;' })
      .length>0,source);
  }
  const valid=moduleBoundaryViolations({ [root]: "import './platform/config.js';",'src/platform/config.js': 'export const config=true;' });
  assert.deepEqual(valid,[]);
});


test('one-key policy is explicit and confined to INT without changing the production security profile',t=>{
  const env={ ...fixture(),PROTECTED_PLATFORM_MINIMUM_PASSKEYS: '1' },bundle=load(t,env);
  assert.equal(bundle.config.mode,'production');assert.equal(bundle.config.minimumCredentialCount,1);
  assert.equal(bundle.authenticationFactory({ pool: noIo(),leasePool: noIo() })
    .platformPasskeyService.configuration().minimumPasskeys,1);
  for (const environment of ['dev','prod']) {
    assert.throws(()=>loadProtectedPlatformConfiguration({ ...fixture(environment),PROTECTED_PLATFORM_MINIMUM_PASSKEYS: '1' }),
      /PASSKEY_MINIMUM_INVALID/);
  }
  for (const minimum of ['0','3','01','1.0',' 1','true','']) {
    assert.throws(()=>loadProtectedPlatformConfiguration({ ...fixture(),PROTECTED_PLATFORM_MINIMUM_PASSKEYS: minimum }));
  }
  assert.equal(load(t,fixture()).config.minimumCredentialCount,2);
});
