import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformPasskeyEnrollmentService } from '../src/platform/identity/passkey-enrollment-service.js';
import { createPlatformPasskeyEnrollmentGrant } from '../src/platform/identity/passkey-enrollment-grant.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { platformPasskeyFixture } from './support/platform-passkey-fixture.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const providerIdentity = { provider: 'microsoft_entra_platform', tenantReference: OPERATOR, subjectReference: OTHER };
const binding = { operatorId: OPERATOR, operatorSecurityVersion: 4, providerIdentity, environment: 'int', securityEpoch: 8 };

function fixture({ environment = 'int', securityEpoch = 8 } = {}) {
  const key = platformPasskeyFixture();
  const minted = createPlatformPasskeyEnrollmentGrant({ ...binding, kind: 'bootstrap',
    approvalReference: 'CM-INT-OWNER-001', issuedFromSessionId: null, correlationId: OTHER, ttlSeconds: 600 });
  let pending = null; let candidate = null; let active = false; let expired = false;
  const calls = { primary: 0, begin: 0, register: 0, complete: 0 };
  function matches(value) {
    return pending && !active && !expired && ['stateHash', 'browserHash', 'environment', 'securityEpoch']
      .every(name => pending[name] === value[name]);
  }
  // Application-port fixture only. Production locking, attempt budgets, DB
  // expiry and atomic audit/credential insertion require separate DB evidence.
  const repository = {
    async begin(value) {
      calls.begin += 1;
      assert.equal(Object.hasOwn(value, 'token'), false);
      if (value.tokenHash !== minted.record.tokenHash) return null;
      pending = { ...value, userHandle: key.userHandle, excludeCredentialIds: [] };
      return pending;
    },
    async findRegistration(value) { return matches(value) && !candidate ? pending : null; },
    async stageCredential(value, verify) {
      calls.register += 1;
      if (!matches(value) || candidate) return null;
      candidate = await verify(pending);
      return { possessionChallenge: pending.possessionChallenge, credentialId: candidate.id };
    },
    async complete(value, verify) {
      calls.complete += 1;
      if (!matches(value) || !candidate) return false;
      const { backedUp, ...publicCredential } = candidate;
      const proof = await verify({ ...pending, credential: { ...publicCredential, userHandle: key.userHandle,
        operatorId: OPERATOR, environment: 'int' } });
      assert.equal(proof.credentialId, key.credential.id);
      active = true;
      return true;
    },
  };
  const service = createPlatformPasskeyEnrollmentService({ repository, environment, securityEpoch,
    primaryOperatorService: { async resolve(assertion) {
      calls.primary += 1;
      assert.equal(assertion, 'verified-opaque-primary');
      return { operatorId: OPERATOR, securityVersion: 4, providerIdentity };
    } }, verifier: createPlatformPasskeyVerifier({ environment, publicOrigin: 'https://ops-int.example.com' }) });
  async function start(grant = minted.grant) {
    const result = await service.start({ assertion: 'verified-opaque-primary', grant, correlationId: OTHER });
    const cookie = result.setCookie.split(';')[0].split('=')[1];
    return { ...result, cookie };
  }
  const registrationResponse = () => key.response('create', { client: { challenge: pending.registrationChallenge } });
  const assertionResponse = (changes = {}) => key.response('get', { ...changes,
    client: { challenge: pending.possessionChallenge, ...changes.client } });
  return { service, start, calls, key, registrationResponse, assertionResponse,
    active: () => active, pending: () => pending, expire: () => { expired = true; } };
}

test('registration requires verified primary and exact independent grant; only a later signed assertion completes enrollment', async () => {
  const f = fixture(); const started = await f.start();
  assert.equal(started.status, 'registration_required');
  assert.equal(started.options.authenticatorSelection.userVerification, 'required');
  assert.match(started.setCookie, /HttpOnly; Secure; SameSite=Strict; Max-Age=120$/);
  assert.notEqual(f.pending().registrationChallenge, f.pending().possessionChallenge);
  assert.equal(f.active(), false);
  assert.deepEqual(await f.service.registrationOptions(started.cookie), { state: started.state, options: started.options });
  const input = { cookie: started.cookie, state: started.state, response: f.registrationResponse() };
  await assert.rejects(f.service.complete(input), /ENROLLMENT_REJECTED/);
  const registered = await f.service.register(input);
  assert.equal(registered.status, 'possession_required');
  assert.equal(registered.options.challenge, f.pending().possessionChallenge);
  assert.equal(f.active(), false, 'none attestation cannot activate a credential');
  assert.equal(Object.hasOwn(registered, 'principal'), false);
  await assert.rejects(f.service.registrationOptions(started.cookie), /ENROLLMENT_REJECTED/);
  const completed = await f.service.complete({ ...input, response: f.assertionResponse() });
  assert.deepEqual(completed, { status: 'credential_enrolled',
    setCookie: 'cm_platform_passkey_tx=; Path=/api/v1/platform/auth/passkey; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  assert.equal(f.active(), true);
  assert.equal(Object.hasOwn(completed, 'principal'), false);
  await assert.rejects(f.service.complete({ ...input, response: f.assertionResponse() }), /ENROLLMENT_REJECTED/);
});

test('foreign grant, browser, body state, epoch or environment cannot enroll or expose registration options', async () => {
  const f = fixture();
  await assert.rejects(f.start({ grantId: OTHER, token: f.key.challenge }), /ENROLLMENT_REJECTED/);
  const started = await f.start();
  const other = await fixture().start();
  await assert.rejects(f.service.registrationOptions(other.cookie), /ENROLLMENT_REJECTED/);
  const response = f.registrationResponse();
  for (const change of [{ state: other.state }, { cookie: other.cookie }, { operatorId: OTHER }, { cookie: 'x'.repeat(87) }]) {
    await assert.rejects(f.service.register({ cookie: started.cookie, state: started.state, response, ...change }), /ENROLLMENT_REJECTED/);
  }
  assert.equal(f.active(), false);
  for (const config of [{ environment: 'dev' }, { securityEpoch: 9 }]) {
    await assert.rejects(fixture(config).start(), /ENROLLMENT_REJECTED/);
  }
  f.expire();
  await assert.rejects(f.service.registrationOptions(started.cookie), /ENROLLMENT_REJECTED/);
});

test('wrong challenge, origin, missing UV and different private key fail possession without activating the staged key', async () => {
  const f = fixture(); const started = await f.start();
  const input = { cookie: started.cookie, state: started.state };
  await assert.rejects(f.service.register({ ...input, response: f.key.response('create') }), /PASSKEY_REJECTED/);
  await f.service.register({ ...input, response: f.registrationResponse() });
  for (const response of [f.assertionResponse({ client: { challenge: f.pending().registrationChallenge } }),
    f.assertionResponse({ client: { origin: 'https://foreign.example.com' } }), f.assertionResponse({ flags: 0x01 }),
    platformPasskeyFixture().response('get', { client: { challenge: f.pending().possessionChallenge } })]) {
    await assert.rejects(f.service.complete({ ...input, response }), /PASSKEY_REJECTED/);
    assert.equal(f.active(), false);
  }
  assert.equal((await f.service.complete({ ...input, response: f.assertionResponse() })).status, 'credential_enrolled');
});

test('caller authority and missing enrollment ports fail before repository or primary access', async () => {
  const f = fixture();
  for (const change of [{ roles: ['platform_security_admin'] }, { operatorId: OTHER }, { correlationId: null },
    { grant: { grantId: OTHER, token: f.key.challenge, approved: true } }]) {
    await assert.rejects(f.service.start({ assertion: 'verified-opaque-primary', grant: { grantId: OTHER, token: f.key.challenge },
      correlationId: OTHER, ...change }), /ENROLLMENT_REJECTED/);
  }
  assert.equal(f.calls.primary, 0);
  assert.equal(f.calls.begin, 0);
  assert.throws(() => createPlatformPasskeyEnrollmentService(), /ENROLLMENT_REPOSITORY_REQUIRED/);
});

test('synthetic Demo cannot reach the real enrollment application through an intermediary', () => {
  for (const surface of ['customer', 'platform']) {
    const violations = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/enroll.js';",
      'src/integrations/enroll.js': "import '../platform/identity/passkey-enrollment-service.js';",
      'src/platform/identity/passkey-enrollment-service.js': 'export const service = true;',
    });
    assert.ok(violations.length > 0);
  }
});
