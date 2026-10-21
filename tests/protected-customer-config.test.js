import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadProtectedCustomerConfiguration } from '../src/protected-customer-config.js';
import { protectedRuntimeConfigurationKeys } from '../src/protected-runtime-config.js';
import { assertProductionConfig } from '../src/config.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

function fixture(environment='int') {
  const database=new URL('postgresql://db.example.test/neondb');
  database.username=`cm_protected_${environment}_customer`;database.password=Buffer.alloc(32,9).toString('base64url');
  return { NODE_ENV: 'production',PROTECTED_ENVIRONMENT: environment,PROTECTED_SECURITY_EPOCH: randomUUID(),
    PROTECTED_CUSTOMER_ORIGIN: `https://app-${environment}.example.test`,
    PROTECTED_PLATFORM_ORIGIN: `https://ops-${environment}.example.test`,
    PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),
    PROTECTED_CUSTOMER_DATABASE_URL: database.href,PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: randomUUID(),PROTECTED_PEER_ENTRA_CLIENT_ID: randomUUID(),
    PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'e'.repeat(48),PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),
    PROTECTED_TENANT_AUDIT_HMAC_SECRET: 'a'.repeat(48),PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'p'.repeat(48),PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),
    PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),
    PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
}
function load(t,env) { const result=loadProtectedCustomerConfiguration(env);t.after(()=>result.cipher.destroy());return result; }

for (const environment of ['dev','int','prod']) {
  test(`owned ${environment} Customer configuration retains production constraints and independent protected deployment scope`,t=>{
    const env=fixture(environment),before={ ...env },inherited=Object.keys(process.env),result=load(t,env);
    assert.deepEqual(env,before);assert.deepEqual(Object.keys(process.env),inherited);
    assert.equal(result.config.mode,'production');assert.equal(result.config.deploymentEnvironment,environment);
    assert.equal(result.config.databaseSsl,'verify-full');assert.equal(result.config.databasePoolMax,2);
    assert.equal(result.profile.leaseDatabase.databasePoolMax,1);assertProductionConfig(result.config);
    assert.equal(result.config.entraAuthority,'https://login.microsoftonline.com/organizations');
    assert.equal(result.config.entraRedirectUri,`${env.PROTECTED_CUSTOMER_ORIGIN}/api/v1/auth/microsoft/callback`);
    assert.equal(result.authentication.synthetic,null);assert.equal(result.mailProvider,null);
    assert.equal(result.config.auditHmacSecret,env.PROTECTED_TENANT_AUDIT_HMAC_SECRET);
    assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.config));assert.ok(Object.isFrozen(result.authentication));
    assert.equal(result.platformSessionService,undefined);assert.equal(result.platformAuditHmacSecret,undefined);
  });
}

test('Customer configuration rejects missing/aliased secrets, unsafe identity/options and unknown input without reflecting values',
t=>{
  const env=fixture();
  for (const key of ['PROTECTED_CUSTOMER_CSRF_SECRET','PROTECTED_CUSTOMER_EMAIL_CODE_SECRET','PROTECTED_PEER_ENTRA_CLIENT_ID',
    'PROTECTED_TENANT_AUDIT_HMAC_SECRET','PROTECTED_CUSTODY_KEYRING','PROTECTED_CUSTODY_ACTIVE_KEY_ID']) {
    const changed={ ...env };delete changed[key];assert.throws(()=>loadProtectedCustomerConfiguration(changed));
  }
  for (const changed of [{ PROTECTED_CUSTOMER_UNKNOWN_AUTHORITY: 'true' },{ PROTECTED_PLATFORM_AUDIT_HMAC_SECRET: 'private-fixture' },
    { PROTECTED_CUSTOMER_CSRF_SECRET: env.PROTECTED_TENANT_AUDIT_HMAC_SECRET },{ PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'short' },
    { PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: env.PROTECTED_PEER_ENTRA_CLIENT_ID },{ PROTECTED_CUSTOMER_HOST: 'remote.invalid' },
    { PROTECTED_CUSTOMER_SESSION_TTL_SECONDS: '999999' },{ PROTECTED_CUSTOMER_PORT: '0' },{ DATABASE_URL: '' }]) {
    assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,...changed }),error=>{
      for (const value of Object.values(changed).filter(value=>value.length>20)) assert.equal(error.message.includes(value),false);
      return true;
    });
  }
  const accessor=Object.defineProperty({ ...env },'PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET',
    { get() { return assert.fail('CONFIGURATION_GETTER'); } });
  assert.throws(()=>loadProtectedCustomerConfiguration(accessor),/VALUE_INVALID/);
  const aliasedDatabase=new URL(env.PROTECTED_CUSTOMER_DATABASE_URL);aliasedDatabase.password=env.PROTECTED_CUSTOMER_CSRF_SECRET;
  assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,PROTECTED_CUSTOMER_DATABASE_URL: aliasedDatabase.href }),
    /SECRET_ALIAS_FORBIDDEN/);
  assert.equal(typeof load(t,env).cipher.recipientLookup,'function');
});

test('full Customer configuration authority cannot enter lower layers or either closed Demo surface',()=>{
  const root='src/protected-customer-config.js';
  for (const source of ['src/domain/probe.js','src/application/probe.js','src/http/probe.js','src/integrations/probe.js',
    'src/demo/customer-main.js','src/demo/platform-main.js']) {
    const violations=moduleBoundaryViolations({ [source]: "import '../protected-customer-config.js';",
      [root]: 'export const config=true;' });
    assert.ok(violations.length>0,source);
  }
});

test('custody key rotation retains old encrypted invitations and stable lookup while malformed/duplicated rings remain closed',t=>{
  const env=fixture(),original=load(t,env),scope={ environment: 'int',mailboxId: randomUUID(),recordId: randomUUID(),
    purpose: 'mailbox_recipient',tenantId: null };
  const bytes=Buffer.from('Synthetic@example.test'),envelope=original.cipher.seal(bytes,scope);
  const next={ ...env,PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'next',PROTECTED_CUSTODY_KEYRING: JSON.stringify([
    ...JSON.parse(env.PROTECTED_CUSTODY_KEYRING),{ id: 'next',key: Buffer.alloc(32,4).toString('base64url') }]) };
  const rotated=load(t,next),opened=rotated.cipher.open(envelope,scope);
  try { assert.deepEqual(opened,bytes); } finally { opened.fill(0);bytes.fill(0); }
  assert.equal(rotated.cipher.recipientLookup('Synthetic@example.test'),original.cipher.recipientLookup('Synthetic@example.test'));
  for (const ring of ['invalid','{}','[]',JSON.stringify(Array(9).fill(JSON.parse(env.PROTECTED_CUSTODY_KEYRING)[0])),
    JSON.stringify([{ id: 'initial',key: 'x'.repeat(43) }]),
    JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url'),issueSession: true }])]) {
    assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,PROTECTED_CUSTODY_KEYRING: ring }),/CUSTODY_/);
  }
  assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'missing' }),/CIPHERTEXT_INVALID/);
});

test('handoff is explicit DEV/INT configuration and cannot appear in PROD or borrow another purpose key',t=>{
  const env=fixture();
  const configured=load(t,{ ...env,PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) });
  assert.equal(configured.authentication.synthetic.platformOrigin,env.PROTECTED_PLATFORM_ORIGIN);
  assert.equal(configured.authentication.synthetic.platformSecurityEpoch,7);
  for (const changed of [{ PROTECTED_SYNTHETIC_ENABLED: 'true' },{ PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) },
    { PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: env.PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET }]) {
    assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,...changed }));
  }
  assert.throws(()=>loadProtectedCustomerConfiguration({ ...fixture('prod'),PROTECTED_SYNTHETIC_ENABLED: 'true',
    PROTECTED_HANDOFF_SECRET: 'h'.repeat(48) }),/SYNTHETIC_INVALID/);
});

test('mail configuration creates only the canonical bounded adapter and performs no startup send',t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('CONFIGURATION_CANNOT_SEND_MAIL'));
  const env=fixture(),apiKey=`re_${Buffer.alloc(32,8).toString('base64url')}`;
  const configured=load(t,{ ...env,PROTECTED_CUSTOMER_MAIL_API_KEY: apiKey,PROTECTED_CUSTOMER_MAIL_SENDER: 'Sender@example.test' });
  assert.equal(typeof configured.mailProvider.send,'function');
  for (const changed of [{ PROTECTED_CUSTOMER_MAIL_API_KEY: apiKey },{ PROTECTED_CUSTOMER_MAIL_SENDER: 'Sender@example.test' },
    { PROTECTED_CUSTOMER_MAIL_API_KEY: 'invalid',PROTECTED_CUSTOMER_MAIL_SENDER: 'Sender@example.test' }]) {
    assert.throws(()=>loadProtectedCustomerConfiguration({ ...env,...changed }));
  }
  assert.ok(Object.isFrozen(protectedRuntimeConfigurationKeys('customer')));
  assert.throws(()=>protectedRuntimeConfigurationKeys('browser'),/SURFACE_INVALID/);
});
