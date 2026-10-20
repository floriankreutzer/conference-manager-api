import assert from 'node:assert/strict';
import test from 'node:test';
import { platformHttpBoundaryViolations } from '../scripts/platform-http-boundary-policy.mjs';

function sources(dependency) {
  return new Map([
    ['src/platform/http/passkey-transport.js', `import '../identity/${dependency}.js';`],
    [`src/platform/identity/${dependency}.js`, 'export const contract = Object.freeze({});'],
  ]);
}
test('Platform HTTP can use exact cookie contracts but still cannot import identity services, verifier or enrollment authority', () => {
  for (const dependency of ['passkey-auth-cookie','passkey-enrollment-cookie','session-cookie']) {
    assert.deepEqual(platformHttpBoundaryViolations(sources(dependency)), []);
  }
  for (const dependency of ['passkey-auth-service','passkey-verifier','passkey-enrollment-grant','passkey-enrollment-flow']) {
    assert.ok(platformHttpBoundaryViolations(sources(dependency)).length > 0, dependency);
  }
});
