import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Demo HTTP servers serialize normal requests with reset and keep reset exclusive', async () => {
  const [customer, platform] = await Promise.all([
    readFile('src/demo/customer-server.js', 'utf8'),
    readFile('src/demo/platform-server.js', 'utf8'),
  ]);
  assert.match(customer, /withDemoRuntimeSharedGate\(demoRuntimeGatePool/);
  assert.match(platform, /withDemoRuntimeSharedGate\(demoRuntimeGatePool/);
  assert.match(customer, /LIVENESS_PATH[\s\S]*await app\(request, response\)[\s\S]*withDemoRuntimeSharedGate/);
  assert.match(platform, /LIVENESS_PATH[\s\S]*await app\(request, response\)[\s\S]*withDemoRuntimeSharedGate/);
  assert.match(customer, /demoRuntimeGatePool === persistence\.pool/);
  assert.match(platform, /demoRuntimeGatePool === persistence\.pool/);
  assert.match(platform, /RESET_PATH/);
  assert.match(platform, /request\.method === 'POST'/);
  assert.match(customer, /DEMO_RUNTIME_UNAVAILABLE/);
  assert.match(platform, /PLATFORM_DEMO_RUNTIME_UNAVAILABLE/);
  assert.match(customer, /applySecurityHeaders/);
  assert.match(platform, /applyPlatformSecurityHeaders/);
  assert.doesNotMatch(customer, /src\/index|entra-client|microsoft365-client/);
  assert.doesNotMatch(platform, /platform-main|platform-production-authentication/);
});
