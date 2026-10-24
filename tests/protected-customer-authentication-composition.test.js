import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createProtectedCustomerAuthentication } from '../src/protected-customer-authentication-composition.js';
import { createCustomerAuthenticationComposition } from '../src/customer-authentication-composition.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const EPOCH='bd000000-0000-4000-8000-000000000002';
function fixture(t,environment='int') {
  const unused=()=>assert.fail('CONSTRUCTION_MUST_NOT_ACCESS_DATABASE_OR_PROVIDER');
  const pool=()=>({ query: unused,connect: unused });
  const config=Object.freeze({ ...loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: 'https://customer-int.example.com',
    AUDIT_HMAC_SECRET: 'a'.repeat(48),CSRF_SECRET: 's'.repeat(48) }),deploymentEnvironment: environment });
  const persistence={ pool: pool() },leasePool=pool();
  const cipher=createCustomerAccessCipher({ environment,activeKeyId: 'initial',keys: new Map([['initial',Buffer.alloc(32,3)]]),
    lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const synthetic={ platformOrigin: 'https://ops-int.example.com',platformSecurityEpoch: 7,
    browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48) };
  return { config,persistence,leasePool,environment,securityEpoch: EPOCH,cipher,
    emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48),synthetic };
}

test('owned Customer assembly exposes only normal HTTP sessions and opt-in routes without constructing generic authentication',t=>{
  const options=fixture(t),assembly=createProtectedCustomerAuthentication(options);
  assert.ok(Object.isFrozen(assembly));assert.ok(Object.isFrozen(assembly.routeModules));
  assert.deepEqual(assembly.routeModules.map(route=>route.id),
    ['microsoft-role-mappings','customer-email-authentication','customer-invitations','synthetic-customer-handoff']);
  const context={ config: options.config,persistence: options.persistence,authenticationFactory: assembly.authenticationFactory };
  const result=createCustomerAuthenticationComposition(context);
  assert.equal(result.entraAuthService,null);assert.equal(result.onboardingService,null);
  assert.deepEqual(Object.keys(result.sessionService).sort(),
    ['clearCookie','csrfTokenForPrincipal','resolvePrincipal','revoke','verifyCsrf']);
  assert.equal(result.sessionService.issue,undefined);assert.equal(result.sessionService.rotate,undefined);
  assert.match(result.sessionService.clearCookie(),/^cm_session=;.*Max-Age=0/);
  for (const changed of [{ config: { ...options.config } },{ persistence: { ...options.persistence } }]) {
    assert.throws(()=>assembly.authenticationFactory({ ...context,...changed }),/AUTHENTICATION_CONTEXT_INVALID/);
  }
  assert.throws(()=>createCustomerAuthenticationComposition({ ...context,entraClient: {} }),/AUTHENTICATION_COMPOSITION_INVALID/);
});

test('REAL-only Customer assembly supports every environment and does not install a delegation route',t=>{
  for (const environment of ['dev','int','prod']) {
    const options=fixture(t,environment),assembly=createProtectedCustomerAuthentication({ ...options,synthetic: null });
    assert.deepEqual(assembly.routeModules.map(route=>route.id),
      ['microsoft-role-mappings','customer-email-authentication','customer-invitations']);
  }
});

test('explicit Microsoft admission is added with the same owned HTTP session facade and no construction-time outbound work',t=>{
  const options=fixture(t),unused=()=>assert.fail('NO_CONSTRUCTION_PROVIDER_CALL');
  const assembly=createProtectedCustomerAuthentication({ ...options,microsoftFlowSecret: 'm'.repeat(48),
    microsoftClient: { authorizationUrl: unused,redeemAuthorizationCode: unused,verifyPrimary: unused } });
  assert.deepEqual(assembly.routeModules.map(route=>route.id),
    ['microsoft-role-mappings','customer-email-authentication','customer-invitations',
    'customer-microsoft-authentication','synthetic-customer-handoff']);
});

test('cross-environment, aliased pools, invalid scope and extra/accessor synthetic configuration fail before any database call',t=>{
  const options=fixture(t);
  for (const changed of [{ environment: 'dev' },{ securityEpoch: 'invalid' },{ leasePool: options.persistence.pool },
    { synthetic: { ...options.synthetic,environment: 'dev' } },
    { synthetic: { ...options.synthetic,platformOrigin: options.config.publicOrigin } },
    { synthetic: { ...options.synthetic,get sourceSecret() { return assert.fail('CONFIGURATION_GETTER'); } } }]) {
    assert.throws(()=>createProtectedCustomerAuthentication({ ...options,...changed }));
  }
  assert.throws(()=>createProtectedCustomerAuthentication(fixture(t,'prod')),/SYNTHETIC_HANDOFF_INPUT_INVALID/);
});

test('owned authentication assembly stays outside business/provider/HTTP layers and both closed Demo import graphs',()=>{
  const root='src/protected-customer-authentication-composition.js';
  for (const source of ['src/domain/probe.js','src/application/probe.js','src/http/probe.js',
    'src/persistence/postgres/probe.js','src/integrations/probe.js','src/platform/identity/probe.js',
    'src/demo/customer-main.js','src/demo/platform-main.js']) {
    const relative=source.startsWith('src/persistence/') || source.startsWith('src/platform/') ? '../../' : '../';
    assert.ok(moduleBoundaryViolations({ [source]: `import '${relative}protected-customer-authentication-composition.js';`,
      [root]: 'export const assembly=true;' }).length>0,source);
  }
  const violations=moduleBoundaryViolations({ [root]: "import './demo/probe.js';",'src/demo/probe.js': 'export const probe=true;' });
  assert.ok(violations.some(message=>message.includes('Production composition must not reach the Demo runtime')));
});
