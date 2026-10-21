import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeProtectedFrontendFixture } from '../tests/support/protected-frontend-artifact-fixture.js';
import { createProtectedBrowserRuntimeFixture } from './support/protected-browser-runtime-fixture.js';
import { exchangeProtectedRuntime } from './support/protected-runtime-process-fixture.js';

test('qualified browser bootstrap serves pinned files in both actual TLS/SCRAM max1 roots outside their repository',async()=>{
  const previousDirectory=process.cwd();let fixture;
  const artifacts=fileURLToPath(new URL('../.protected-frontend/',import.meta.url));let created=false;
  try {
    await mkdir(artifacts);created=true;const hostedFrontend={};
    for (const surface of ['customer','platform']) {
      const selected=await writeProtectedFrontendFixture(`${artifacts}/${surface}`,{ surface,environment: 'int',
        apiCommit: 'a'.repeat(40),frontendCommit: 'b'.repeat(40),customerOrigin: 'https://app-int.example.test',
        platformOrigin: 'https://ops-int.example.com',syntheticEnabled: true });
      hostedFrontend[surface]=selected.hostedFrontendSha256;
    }
    process.chdir('/tmp');
    fixture=await createProtectedBrowserRuntimeFixture({ apiCommit: 'a'.repeat(40),frontendCommit: 'b'.repeat(40),hostedFrontend });
    assert.equal(process.cwd(),'/tmp','bootstrap always restores its caller directory');
    const platform=await exchangeProtectedRuntime('platform',fixture.ports.platform,'/api/v1/platform/session',{
      headers: { cookie: fixture.initialSetCookie.split(';')[0] } });
    assert.equal(platform.status,200);assert.equal(JSON.parse(platform.text).assurance.level,'mfa');
    assert.match(fixture.initialSetCookie,/Secure/);assert.match(fixture.initialSetCookie,/HttpOnly/);
    assert.equal((await exchangeProtectedRuntime('customer',fixture.ports.customer,'/api/v1/session')).status,401);
    assert.equal((await exchangeProtectedRuntime('platform',fixture.ports.platform,'/api/v1/session')).status,404);
    assert.equal((await exchangeProtectedRuntime('customer',fixture.ports.customer,'/')).status,200);
    assert.equal((await exchangeProtectedRuntime('platform',fixture.ports.platform,'/platform-admin/')).status,200);
    for (const surface of ['customer','platform']) {
      assert.equal((await exchangeProtectedRuntime(surface,fixture.ports[surface],'/manifest.json')).status,404);
      assert.equal((await exchangeProtectedRuntime(surface,fixture.ports[surface],'/scripts/protected-key.js')).status,404);
      assert.equal((await exchangeProtectedRuntime(surface,fixture.ports[surface],'/assets/fixture.css')).status,200);
    }
    const evidence=await fixture.evidence();assert.equal(evidence.tenantChainsVerified,0);assert.deepEqual(evidence.tenants,[]);
    assert.equal(fixture.keys.length,2);assert.notEqual(fixture.keys[0].credential.id,fixture.keys[1].credential.id);
  } finally { try { await fixture?.close(); } finally {
    process.chdir(previousDirectory);if (created) await rm(artifacts,{ recursive: true,force: true });
  } }
});
