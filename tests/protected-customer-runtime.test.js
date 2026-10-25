import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import test from 'node:test';
import { createProtectedCustomerRuntime } from '../src/protected-customer-runtime.js';
import { createHttpServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

function fixture(environment='int') {
  // Discard port on loopback: no external database, credential or DNS lookup.
  const database=new URL('postgresql://127.0.0.1:9/unavailable_fixture');
  database.username=`cm_protected_${environment}_customer`;database.password=Buffer.alloc(32,9).toString('base64url');
  return { NODE_ENV: 'production',PROTECTED_ENVIRONMENT: environment,PROTECTED_SECURITY_EPOCH: randomUUID(),
    PROTECTED_CUSTOMER_ORIGIN: `https://app-${environment}.example.test`,
    PROTECTED_PLATFORM_ORIGIN: `https://ops-${environment}.example.com`,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',
    PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_CUSTOMER_DATABASE_URL: database.href,PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: randomUUID(),
    PROTECTED_PEER_ENTRA_CLIENT_ID: randomUUID(),PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'e'.repeat(48),
    PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),PROTECTED_TENANT_AUDIT_HMAC_SECRET: 'a'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'p'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
    PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
}

for (const environment of ['dev','int','prod']) {
  test(`owned ${environment} Customer runtime retains closed dependencies without exposing an issuer or infrastructure`,async()=>{
    const env=fixture(environment),before={ ...env },runtime=await createProtectedCustomerRuntime(env);
    assert.ok(Object.isFrozen(runtime));assert.deepEqual(Object.keys(runtime),['start','stop']);assert.deepEqual(env,before);
    const stopping=runtime.stop();assert.equal(runtime.stop(),stopping);await stopping;
    await assert.rejects(runtime.start(),/PROTECTED_CUSTOMER_RUNTIME_STATE_INVALID/);
  });
}

test('Customer runtime refuses malformed configuration and replacement authority without reflecting values',async()=>{
  const env=fixture();
  for (const change of [{ PROTECTED_CUSTOMER_ISSUER: 'replace' },{ PROTECTED_PLATFORM_CSRF_SECRET: 'PRIVATE_FIXTURE_DETAIL' },
    { PROTECTED_CUSTOMER_CSRF_SECRET: 'PRIVATE_FIXTURE_DETAIL' },{ PROTECTED_CUSTOMER_PORT: '0' },
    { NODE_ENV: 'test' },{ PROTECTED_ENVIRONMENT: 'demo' }]) {
    await assert.rejects(createProtectedCustomerRuntime({ ...env,...change }),
      { message: 'PROTECTED_CUSTOMER_RUNTIME_CONFIGURATION_INVALID' });
  }
});

test('actual unavailable database and concurrent shutdown cannot open a Customer listener or leave restart authority',async()=>{
  const runtime=await createProtectedCustomerRuntime(fixture());
  const start=runtime.start(),stop=runtime.stop();
  await assert.rejects(start,{ message: 'PROTECTED_CUSTOMER_RUNTIME_START_FAILED' });await stop;
  await assert.rejects(runtime.start(),/PROTECTED_CUSTOMER_RUNTIME_STATE_INVALID/);await runtime.stop();
});

test('canonical HTTP server retains limits and passes its actual application through the owned execution wrapper',async t=>{
  const config=loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: 'https://app-int.example.test' });let wrapped=0,calls=0;
  const server=createHttpServer({ config,requestHandlerFactory: app=>{
    wrapped++;assert.equal(typeof app,'function');return (...args)=>{ calls++;return app(...args); };
  } });
  assert.equal(wrapped,1);assert.equal(server.requestTimeout,config.requestTimeoutMs);assert.equal(server.maxHeadersCount,100);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())));
  const status=await new Promise((resolve,reject)=>{
    const call=request({ hostname: '127.0.0.1',port: server.address().port,path: '/api/v1/health/live',
      headers: { host: 'app-int.example.test' } },response=>{ response.resume();response.once('end',()=>resolve(response.statusCode)); });
    call.once('error',reject);call.end();
  });assert.equal(status,200);assert.equal(calls,1);
  assert.throws(()=>createHttpServer({ config,requestHandlerFactory: true }),/HTTP_REQUEST_HANDLER_FACTORY_INVALID/);
  assert.throws(()=>createHttpServer({ config,requestHandlerFactory: ()=>({}) }),/HTTP_REQUEST_HANDLER_INVALID/);
});

test('protected Customer process authority cannot enter lower layers or closed Demo graphs',()=>{
  for (const root of ['src/protected-customer-runtime.js','src/protected-customer-main.js']) {
    for (const source of ['src/domain/probe.js','src/application/probe.js','src/http/probe.js','src/integrations/probe.js',
      'src/demo/customer-main.js','src/demo/platform-main.js']) {
      assert.ok(moduleBoundaryViolations({ [source]: `import '../${root.split('/').at(-1)}';`,[root]: 'export const root=true;' })
        .length>0,source);
    }
  }
});


test('explicit REAL owner process construction retains private provider/transaction custody without startup I/O',async()=>{
  for (const environment of ['dev','int','prod']) {
    const env={ ...fixture(environment),PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED: 'true',PROTECTED_OWNER_HANDOFF_SECRET: 'o'.repeat(48) };
    const runtime=await createProtectedCustomerRuntime(env);assert.deepEqual(Object.keys(runtime),['start','stop']);await runtime.stop();
  }
});
