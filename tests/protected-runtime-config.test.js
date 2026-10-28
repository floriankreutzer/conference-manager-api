import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProtectedRuntimeProfile } from '../src/protected-runtime-config.js';
import { loadConfig } from '../src/config.js';
import { loadPlatformConfig } from '../src/platform/config.js';
import { loadDemoCustomerConfig,loadDemoPlatformConfig } from '../src/demo/config.js';
const EPOCH='bc000000-0000-4000-8000-000000000001';
function database(environment,surface) {
  const url=new URL('postgresql://db.example.test/neondb');
  url.username=`cm_protected_${environment}_${surface}`;url.password=Buffer.alloc(32,3).toString('base64url');return url.href;
}
function fixture(environment='int',surface='customer') {
  return { NODE_ENV: 'production',PROTECTED_ENVIRONMENT: environment,PROTECTED_SECURITY_EPOCH: EPOCH,
    PROTECTED_CUSTOMER_ORIGIN: `https://app-${environment}.example.test`,
    PROTECTED_PLATFORM_ORIGIN: `https://ops-${environment}.example.test`,
    PROTECTED_PLATFORM_SECURITY_EPOCH: '7',PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),
    [`PROTECTED_${surface.toUpperCase()}_DATABASE_URL`]: database(environment,surface) };
}
for (const environment of ['dev','int','prod']) for (const surface of ['customer','platform']) {
  test(`${environment}/${surface} prepares an immutable separate profile with verified TLS and bounded independent pool configuration`,()=>{
    const env=fixture(environment,surface),before={ ...env },keys=Object.keys(process.env);
    const profile=loadProtectedRuntimeProfile(env,{ surface });
    assert.deepEqual(env,before);assert.deepEqual(Object.keys(process.env),keys);
    assert.equal(profile.environment,environment);assert.equal(profile.surface,surface);assert.equal(profile.securityEpoch,EPOCH);
    assert.equal(profile.platformSecurityEpoch,7);assert.equal(profile.syntheticEnabled,false);
    assert.equal(profile.database.databaseSsl,'verify-full');assert.equal(profile.leaseDatabase.databaseSsl,'verify-full');
    assert.equal(profile.database.databasePoolMax,2);assert.equal(profile.leaseDatabase.databasePoolMax,1);
    assert.notEqual(profile.database,profile.leaseDatabase);assert.ok(Object.isFrozen(profile));
    assert.ok(Object.isFrozen(profile.database));
    assert.equal(Object.hasOwn(profile,'platformAuditHmacSecret'),false);
    assert.deepEqual([profile.apiCommit,profile.frontendCommit],['a'.repeat(40),'b'.repeat(40)]);
    assert.throws(()=>loadConfig(env));assert.throws(()=>loadPlatformConfig(env));
    assert.throws(()=>loadDemoCustomerConfig(env));assert.throws(()=>loadDemoPlatformConfig(env));
  });
}

test('legacy credentials, foreign-surface secrets, invalid origins and unqualified artifacts fail before connection or fallback',()=>{
  for (const key of ['DATABASE_URL','DATABASE_SSL','PLATFORM_DATABASE_URL','DEMO_CUSTOMER_DATABASE_URL','ENTRA_CLIENT_SECRET',
    'OIDC_TRANSACTION_SECRET','PUBLIC_ORIGIN']) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),[key]: '' },{ surface: 'customer' }),/LEGACY_FORBIDDEN/);
  }
  for (const key of ['PROTECTED_PLATFORM_DATABASE_URL','PROTECTED_PLATFORM_AUDIT_HMAC_SECRET','PROTECTED_UNKNOWN_OVERRIDE']) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),[key]: 'private-fixture' },
      { surface: 'customer' }),/CROSS_SURFACE_FORBIDDEN/);
  }
  for (const candidate of ['http://ops-int.example.test','https://127.0.0.1','https://ops-int.example.test:8443',
    'https://ops-int.example.test/path','https://ops-int.example.test?next=foreign','https://localhost']) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),PROTECTED_PLATFORM_ORIGIN: candidate },
      { surface: 'customer' }),/ORIGIN_INVALID/);
  }
  for (const change of [{ NODE_ENV: 'test' },{ PROTECTED_SECURITY_EPOCH: 'old' },{ PROTECTED_PLATFORM_SECURITY_EPOCH: '1' },
    { PROTECTED_ENVIRONMENT: 'demo' },{ PROTECTED_API_COMMIT: 'main' },{ PROTECTED_FRONTEND_COMMIT: 'latest' },
    { PROTECTED_CUSTOMER_ORIGIN: fixture().PROTECTED_PLATFORM_ORIGIN }]) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),...change },{ surface: 'customer' }),/PROTECTED_RUNTIME_CONFIG_/);
  }
  const accessor=Object.defineProperty(fixture(),'PROTECTED_SECURITY_EPOCH',{ get() { assert.fail('GETTER_EXECUTED'); } });
  assert.throws(()=>loadProtectedRuntimeProfile(accessor,{ surface: 'customer' }),/REQUIRED/);
});

test('role/environment aliases, insecure connection parameters, pool excess and synthetic PROD remain closed without secret reflection',
()=>{
  const own='PROTECTED_CUSTOMER_DATABASE_URL';
  for (const url of [database('prod','customer'),database('int','platform'),database('int','customer')+'?sslmode=disable',
    database('int','customer')+'?host=foreign.invalid',database('int','customer').replace('neondb','neondb/nested')]) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),[own]: url },{ surface: 'customer' }),error=>{
      assert.equal(error.message,'PROTECTED_RUNTIME_CONFIG_DATABASE_INVALID');assert.equal(error.message.includes(url),false);return true;
    });
  }
  for (const change of [{ PROTECTED_DATABASE_SSL: 'disable' },{ PROTECTED_DATABASE_POOL_MAX: '0' },
    { PROTECTED_DATABASE_POOL_MAX: '5',PROTECTED_LEASE_POOL_MAX: '5' },{ PROTECTED_LEASE_POOL_MAX: 'Infinity' },
    { PROTECTED_SYNTHETIC_ENABLED: 'yes' }]) {
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture(),...change },{ surface: 'customer' }),/PROTECTED_RUNTIME_CONFIG_/);
  }
  assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture('prod'),PROTECTED_SYNTHETIC_ENABLED: 'true' },{ surface: 'customer' }),
    /SYNTHETIC_INVALID/);
  assert.equal(loadProtectedRuntimeProfile({ ...fixture(),PROTECTED_SYNTHETIC_ENABLED: 'true' },
    { surface: 'customer' }).syntheticEnabled,true);
  assert.throws(()=>loadProtectedRuntimeProfile(fixture(),{ surface: 'browser' }),/SURFACE_INVALID/);
});

for (const surface of ['customer','platform']) {
  test(`${surface} participant profile requires explicit DEV/INT synthetic scope and closed booleans`,()=>{
    const base=fixture('int',surface),scope={ surface };
    assert.equal(loadProtectedRuntimeProfile(base,scope).syntheticParticipantsEnabled,false);
    for (const environment of ['dev','int']) {
      const selected=loadProtectedRuntimeProfile({ ...fixture(environment,surface),PROTECTED_SYNTHETIC_ENABLED: 'true',
        PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: 'true' },scope);
      assert.equal(selected.syntheticParticipantsEnabled,true);assert.ok(Object.isFrozen(selected));
    }
    for (const value of ['TRUE','1','yes','',true,null]) {
      assert.throws(()=>loadProtectedRuntimeProfile({ ...base,PROTECTED_SYNTHETIC_ENABLED: 'true',
        PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: value },scope),/PROTECTED_RUNTIME_CONFIG_/);
    }
    assert.throws(()=>loadProtectedRuntimeProfile({ ...base,PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: 'true' },scope),
      /SYNTHETIC_PARTICIPANTS_INVALID/);
    assert.throws(()=>loadProtectedRuntimeProfile({ ...fixture('prod',surface),
      PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: 'true' },scope),/SYNTHETIC_PARTICIPANTS_INVALID/);
    const accessor=Object.defineProperty({ ...base },'PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED',
      { get() { assert.fail('PARTICIPANT_CONFIGURATION_GETTER'); } });
    assert.throws(()=>loadProtectedRuntimeProfile(accessor,scope),/REQUIRED/);
  });
}
