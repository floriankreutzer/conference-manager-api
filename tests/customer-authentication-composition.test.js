import assert from 'node:assert/strict';
import test from 'node:test';
import { backendSaas2BoundaryViolations } from '../scripts/backend-boundary-policy.mjs';
import { loadConfig } from '../src/config.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createCustomerAuthenticationComposition } from '../src/customer-authentication-composition.js';

function session() {
  return Object.freeze({ async resolvePrincipal() { return null; },async verifyCsrf() { return false; },
    csrfTokenForPrincipal() { return 'c'.repeat(43); },async revoke() { return true; },clearCookie() { return 'cleared'; },
    issue() { assert.fail('PRIVATE_ISSUER_MUST_NOT_ESCAPE'); },rotate() { assert.fail('PRIVATE_ROTATOR_MUST_NOT_ESCAPE'); } });
}

test('owned Customer business composition omits generic session/JIT/OIDC authority',async()=>{
  const config=loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: 'https://localhost',DATABASE_URL: 'postgres://localhost:1/synthetic',
    AUDIT_HMAC_SECRET: 'a'.repeat(32),CSRF_SECRET: 'c'.repeat(32),OIDC_TRANSACTION_SECRET: 'o'.repeat(32),
    ENTRA_CLIENT_ID: 'e0000000-0000-4000-8000-000000000001',
    ENTRA_CLIENT_SECRET: 'e'.repeat(32) });
  const ordinary=createPostgresPersistence(config),service=session();let captured,factories=0,seenSession;
  const persistence=new Proxy(ordinary,{ get(target,key) {
    if (['sessionRepository','jitUserRepository','oidcTransactionRepository'].includes(key)) assert.fail('GENERIC_AUTHORITY_ACCESSED');
    return Reflect.get(target,key);
  } });
  let runtime;
  try {
    runtime=createCustomerComposition({ config,persistence,
      microsoft365Client: Object.fromEntries(['lookupFreeBusy','adminConsentUrl','verifyBasePermissions','discoverRooms']
        .map(name=>[name,()=>assert.fail('NO_PROVIDER_CALL')])),authenticationFactory(context) {
      factories++;assert.equal(context.persistence,persistence);assert.equal(context.config,config);
      assert.equal(typeof context.auditService.createEvent,'function');assert.equal(Object.isFrozen(context),true);
      return { sessionService: service };
    },routeModulesFactory(context) { seenSession=context.sessionService;return []; },
    httpServerFactory(options) { captured=options;return { close() {},closeAllConnections() {} }; } });
    assert.equal(factories,1);assert.equal(runtime.sessionService,captured.sessionService);assert.equal(seenSession,runtime.sessionService);
    assert.equal(captured.entraAuthService,null);assert.equal(captured.onboardingService,null);
    assert.equal(await runtime.sessionService.resolvePrincipal({ headers: {} }),null);
    assert.equal(runtime.sessionService.issue,undefined);assert.equal(runtime.sessionService.rotate,undefined);
    assert.equal(typeof captured.requestService.getRequest,'function');
    assert.equal(typeof captured.productionApplicationService.getProfile,'function');
  } finally { if (runtime) await runtime.stop();else await ordinary.close(); }
});

test('owned identity result is closed, cannot mix a generic provider and never falls back on absent or asynchronous ports',()=>{
  const config=loadConfig({ NODE_ENV: 'test' }),context={ config,persistence: null,auditService: null };
  for (const factory of [false,()=>null,async()=>({ sessionService: session() }),()=>({ sessionService: {} }),
    ()=>({ sessionService: session(),entraAuthService: {} }),()=>({ get sessionService() { return assert.fail('NO_ACCESSOR'); } })]) {
    assert.throws(()=>createCustomerAuthenticationComposition({ ...context,authenticationFactory: factory }),
      /CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID/);
  }
  assert.throws(()=>createCustomerAuthenticationComposition({ ...context,entraClient: {},
    authenticationFactory: ()=>({ sessionService: session() }) }),/CUSTOMER_AUTHENTICATION_COMPOSITION_INVALID/);
  assert.deepEqual(createCustomerAuthenticationComposition(context),
    { sessionService: null,onboardingService: null,entraAuthService: null });
  assert.equal(Object.isFrozen(createCustomerAuthenticationComposition({ ...context,
    authenticationFactory: ()=>({ sessionService: session() }) }).sessionService),true);
});


test('authentication construction stays outside domain, application, HTTP and persistence modules',()=>{
  for (const file of ['src/domain/forbidden.js','src/application/forbidden.js','src/http/forbidden.js',
    'src/persistence/postgres/forbidden.js','src/platform/application/forbidden.js']) {
    const depth=file.split('/').length-2;
    const specifier='../'.repeat(depth)+'customer-authentication-composition.js';
    const violations=backendSaas2BoundaryViolations({ [file]: `import '${specifier}';`,
      'src/customer-authentication-composition.js': 'export const composition=true;' });
    assert.equal(violations.some(value=>value.includes('customer-authentication-composition.js')),true);
  }
});
