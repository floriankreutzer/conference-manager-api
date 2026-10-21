import assert from 'node:assert/strict';
import test from 'node:test';
import { createProtectedBrowserRuntimeFixture } from './support/protected-browser-runtime-fixture.js';
import { exchangeProtectedRuntime } from './support/protected-runtime-process-fixture.js';

test('qualified browser bootstrap starts both TLS/SCRAM max1 roots outside their repository without provider injection',async()=>{
  const previousDirectory=process.cwd();let fixture;
  try {
    process.chdir('/tmp');
    fixture=await createProtectedBrowserRuntimeFixture({ apiCommit: 'a'.repeat(40),frontendCommit: 'b'.repeat(40) });
    assert.equal(process.cwd(),'/tmp','bootstrap always restores its caller directory');
    const platform=await exchangeProtectedRuntime('platform',fixture.ports.platform,'/api/v1/platform/session',{
      headers: { cookie: fixture.initialSetCookie.split(';')[0] } });
    assert.equal(platform.status,200);assert.equal(JSON.parse(platform.text).assurance.level,'mfa');
    assert.match(fixture.initialSetCookie,/Secure/);assert.match(fixture.initialSetCookie,/HttpOnly/);
    assert.equal((await exchangeProtectedRuntime('customer',fixture.ports.customer,'/api/v1/session')).status,401);
    assert.equal((await exchangeProtectedRuntime('platform',fixture.ports.platform,'/api/v1/session')).status,404);
    const evidence=await fixture.evidence();assert.equal(evidence.tenantChainsVerified,0);assert.deepEqual(evidence.tenants,[]);
    assert.equal(fixture.keys.length,2);assert.notEqual(fixture.keys[0].credential.id,fixture.keys[1].credential.id);
  } finally { try { await fixture?.close(); } finally { process.chdir(previousDirectory); } }
});
