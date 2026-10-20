import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPlatformPasskeyEnrollmentFlow } from '../src/platform/identity/passkey-enrollment-flow.js';
import { createPlatformPasskeyEnrollmentGrant } from '../src/platform/identity/passkey-enrollment-grant.js';
import { readPlatformPasskeyEnrollmentCookie } from '../src/platform/identity/passkey-enrollment-cookie.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const providerIdentity = { provider: 'microsoft_entra_platform', tenantReference: ID, subjectReference: OTHER };
const context = { operatorId: ID, securityVersion: 4, providerIdentity, primaryAuthenticatedAt: new Date().toISOString() };
const minted = () => createPlatformPasskeyEnrollmentGrant({ operatorId: ID, operatorSecurityVersion: 4, providerIdentity,
  environment: 'int', securityEpoch: 8, kind: 'bootstrap', approvalReference: 'CM-INT-OWNER-001',
  issuedFromSessionId: null, ttlSeconds: 600, correlationId: OTHER });
function fixture() {
  const grant = minted(); const calls = { consume: 0, setup: 0, additional: 0, records: [] };
  const repository = {
    async begin(value) {
      calls.records.push(value); assert.equal(value.tokenHash, grant.record.tokenHash);
      return { registrationChallenge: value.registrationChallenge, userHandle: randomBytes(32).toString('base64url'),
        excludeCredentialIds: [] };
    }, findRegistration() {}, stageCredential() {}, complete() {},
    async issueAdditional(value) {
      calls.additional++; assert.equal(value.principal.operatorId, ID); return { grant: grant.grant };
    },
  };
  const flow = createPlatformPasskeyEnrollmentFlow({ repository, environment: 'int', securityEpoch: 8,
    authService: {
      async consumeEnrollmentPrimary(value, work) {
        calls.consume++; assert.equal(value.cookie, 'verified-browser'); return work(context);
      },
      async executeSetupLogin(value, work) {
        calls.setup++; assert.equal(value.cookie, 'verified-browser'); return work({ principal: {
          operatorId: ID, securityVersion: 4, providerIdentity }, correlationId: OTHER });
      },
    }, verifier: { createChallenge: () => randomBytes(32).toString('base64url'), registrationOptions: async value => value,
      verifyRegistration() {}, authenticationOptions() {}, verifyAuthentication() {} } });
  return { flow, calls, grant };
}

test('only durable primary consumption supplies first-enrollment identity and only grant hashes reach persistence', async () => {
  const f = fixture(); const result = await f.flow.start({ cookie: 'verified-browser', state: 'public-state', grant: f.grant.grant });
  assert.equal(result.status, 'registration_required'); assert.equal(f.calls.consume, 1);
  assert.equal(f.calls.records[0].operatorId, ID); assert.equal(Object.hasOwn(f.calls.records[0], 'token'), false);
  assert.ok(readPlatformPasskeyEnrollmentCookie({ cookie: result.setCookie.split(';')[0] }));
  assert.equal(readPlatformPasskeyEnrollmentCookie({ cookie: `cm_platform_passkey_tx=${'S'.repeat(43)}.${'B'.repeat(43)}` }), null);
  const duplicate = `${result.setCookie.split(';')[0]};${result.setCookie.split(';')[0]}`;
  assert.equal(readPlatformPasskeyEnrollmentCookie({ cookie: duplicate }), null);
});

test('second-key setup uses only the verified internal strong-session port and never exposes the grant or session', async () => {
  const f = fixture(); const result = await f.flow.continueSetup({ cookie: 'verified-browser', state: 'public-state', response: {} });
  assert.equal(result.status, 'registration_required'); assert.equal(f.calls.setup, 1); assert.equal(f.calls.additional, 1);
  assert.equal(Object.hasOwn(result, 'grant'), false); assert.equal(Object.hasOwn(result, 'principal'), false);
});

test('browser-supplied identity, approval, or grant authority is rejected before any trusted port', async () => {
  const f = fixture();
  for (const change of [{ operatorId: OTHER }, { roles: ['platform_security_admin'] },
    { grant: { ...f.grant.grant, approved: true } }]) {
    await assert.rejects(f.flow.start({ cookie: 'verified-browser', state: 'public-state', grant: f.grant.grant, ...change }), /REJECTED/);
  }
  assert.equal(f.calls.consume, 0);
  await assert.rejects(f.flow.continueSetup({ cookie: 'verified-browser', state: 'public-state', response: {}, principal: context }),
    /REJECTED/);
  assert.equal(f.calls.setup, 0);
});

test('neither synthetic Demo can reach the private pending-primary enrollment orchestration', () => {
  for (const surface of ['customer', 'platform']) {
    const result = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/enroll.js';",
      'src/integrations/enroll.js': "import '../platform/identity/passkey-enrollment-flow.js';",
      'src/platform/identity/passkey-enrollment-flow.js': 'export const value = true;',
    });
    assert.ok(result.some(value => value.includes('must not reach real Platform passkey')));
  }
});
