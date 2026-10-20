import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';
import { createPlatformEntraClient, createPlatformEntraPrimaryClient } from '../src/platform/identity/entra-client.js';
import { createPlatformPrimaryOperatorService } from '../src/platform/identity/primary-operator-service.js';
import { normalizeTrustedPlatformIdentity } from '../src/platform/identity/principal.js';
import { createPlatformIdentityService } from '../src/platform/identity/identity-service.js';
import { validatePlatformEntraAuthorizationUrl,
  validatePlatformEntraPrimaryAuthorizationUrl } from '../src/platform/identity/entra-authorization-url.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const DIRECTORY = '22222222-2222-4222-8222-222222222222';
const SUBJECT = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://platform.example.com';
const AUTHORITY = `https://login.microsoftonline.com/${DIRECTORY}`;
const REDIRECT = `${ORIGIN}/api/v1/platform/auth/microsoft/callback`;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const NONCE = 'N'.repeat(43);
const authRequest = { state: 'S'.repeat(43), nonce: NONCE, codeChallenge: 'C'.repeat(43) };
const redeem = { code: 'code', codeVerifier: 'V'.repeat(43),expectedNonce: NONCE,
  expectedNonceHash: createHash('sha256').update(NONCE).digest('hex') };
const config = { clientId: CLIENT, clientSecret: 's'.repeat(48), tenantReference: DIRECTORY,
  authority: AUTHORITY, redirectUri: REDIRECT, publicOrigin: ORIGIN, clock: () => NOW };
const tokenClaims = () => ({ aud: CLIENT, tid: DIRECTORY, oid: SUBJECT, iss: `${AUTHORITY}/v2.0`,
  nonce: NONCE, ver: '2.0', auth_time: NOW / 1000 - 30, iat: NOW / 1000 - 30, exp: NOW / 1000 + 3600,
  roles: ['platform_security_admin'], email: 'ignored@example.com', groups: ['ignored'] });

function application(claims = tokenClaims(), transform = value => value) {
  return {
    async acquireTokenByCode() { return { idTokenClaims: claims }; },
    async getAuthCodeUrl(request) {
      const url = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
      for (const [key, value] of Object.entries({ client_id: CLIENT, redirect_uri: REDIRECT,
        response_type: request.responseType, response_mode: request.responseMode, scope: 'openid profile offline_access',
        max_age: String(request.maxAge), state: request.state, nonce: request.nonce,
        code_challenge: request.codeChallenge, code_challenge_method: request.codeChallengeMethod,
        claims: request.claims, clidata: 'sdk-telemetry' })) url.searchParams.set(key, value);
      return transform(url).toString();
    },
  };
}
const primary = (claims = tokenClaims(), changes = {}) => createPlatformEntraPrimaryClient({
  ...config, application: application(claims), ...changes });

test('primary Microsoft flow requests bounded fresh identity and no Conditional Access or offline scope', async () => {
  const client = primary();
  const url = new URL(await client.authorizationUrl(authRequest));
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('max_age'), '300');
  assert.deepEqual(JSON.parse(url.searchParams.get('claims')), { id_token: { auth_time: { essential: true } } });
  assert.equal(url.searchParams.has('clidata'), false);
  assert.equal(client.verify, undefined);
  const assertion = await client.redeemAuthorizationCode(redeem);
  assert.deepEqual(assertion, { status: 'primary_verified' });
  const identity = await client.verifyPrimary(assertion);
  assert.deepEqual(identity, { provider: 'microsoft_entra_platform', issuer: `${AUTHORITY}/v2.0`,
    audience: CLIENT, tenantReference: DIRECTORY, subjectReference: SUBJECT,
    authenticatedAt: new Date(NOW - 30_000).toISOString() });
  for (const field of ['assurance', 'authenticationContext', 'roles', 'permissions', 'email', 'groups', 'setCookie']) {
    assert.equal(Object.hasOwn(identity, field), false);
  }
  assert.throws(() => normalizeTrustedPlatformIdentity(identity), /PLATFORM_IDENTITY_FIELDS_INVALID/);
  await assert.rejects(client.verifyPrimary(assertion), /NOT_VERIFIED/);
});

test('primary proof is opaque, instance-bound, one-use and rechecks expiry before operator resolution', async () => {
  let now = NOW;
  const client = primary(tokenClaims(), { clock: () => now });
  const assertion = await client.redeemAuthorizationCode(redeem);
  await assert.rejects(primary().verifyPrimary(assertion), /NOT_VERIFIED/);
  await assert.rejects(client.verifyPrimary(JSON.parse(JSON.stringify(assertion))), /NOT_VERIFIED/);
  now += 361_000;
  await assert.rejects(client.verifyPrimary(assertion), /EXPIRED/);
  await assert.rejects(client.verifyPrimary(assertion), /NOT_VERIFIED/);
  assert.throws(() => createPlatformIdentityService({ claimVerifier: client }), /PLATFORM_CLAIM_VERIFIER_REQUIRED/);
});

test('primary protocol rejects wrong directory, audience, issuer, nonce, version and stale or inconsistent times', async () => {
  for (const changes of [{ tid: CLIENT }, { aud: DIRECTORY }, { oid: 'email@example.com' }, { iss: 'https://evil.example/v2.0' },
    { nonce: 'wrong' }, { ver: '1.0' }, { auth_time: undefined }, { auth_time: NOW / 1000 - 361 },
    { auth_time: NOW / 1000 + 61 }, { exp: NOW / 1000 }, { iat: NOW / 1000 + 61 }, { nbf: NOW / 1000 + 61 },
    { exp: NOW / 1000 - 60 }, { iat: NOW / 1000 - 600 }, { auth_time: -1 }]) {
    await assert.rejects(primary({ ...tokenClaims(), ...changes }).redeemAuthorizationCode(redeem), /PLATFORM_/);
  }
  for (const changes of [{ code: 'x'.repeat(4097) }, { codeVerifier: 'browser-verifier' }, { expectedNonceHash: 'invalid' },
    { authenticationContext: 'c1' }]) {
    await assert.rejects(primary().redeemAuthorizationCode({ ...redeem, ...changes }), /PLATFORM_PRIMARY_/);
  }
  assert.throws(() => primary(tokenClaims(), { authenticationMaxAgeSeconds: 301 }), /MAX_AGE_INVALID/);
  assert.throws(() => primary(tokenClaims(), { mfaAuthenticationContext: 'c1' }), /CONTEXT_CONFIGURATION_FORBIDDEN/);
});

test('primary URL policy rejects changed identity/freshness/redirect and cannot substitute for existing CA URL validation', async () => {
  const url = await primary().authorizationUrl(authRequest);
  const contract = { authority: AUTHORITY, clientId: CLIENT, redirectUri: REDIRECT, authenticationMaxAgeSeconds: 300,
    expectedState: authRequest.state, expectedNonce: NONCE, expectedCodeChallenge: authRequest.codeChallenge };
  assert.equal(validatePlatformEntraPrimaryAuthorizationUrl(url, contract), url);
  assert.throws(() => validatePlatformEntraAuthorizationUrl(url, { ...contract, authenticationContext: 'c1' }));
  for (const change of [u => u.searchParams.set('max_age', '900'), u => u.searchParams.set('scope', 'openid profile User.Read'),
    u => u.searchParams.set('claims', '{"id_token":{"acrs":{"essential":true,"values":["c1"]}}}'),
    u => u.searchParams.set('redirect_uri', 'https://evil.example/callback'), u => u.searchParams.set('nonce', 'X'.repeat(43)),
    u => u.searchParams.append('state', authRequest.state), u => { u.hostname = 'evil.example'; }]) {
    const changed = new URL(url); change(changed);
    assert.throws(() => validatePlatformEntraPrimaryAuthorizationUrl(changed.toString(), contract), /AUTHORIZATION_URL_INVALID/);
  }
  const legacy = createPlatformEntraClient({ ...config, application: application(),
    mfaAuthenticationContext: 'c1', stepUpAuthenticationContext: 'c2' });
  await assert.rejects(legacy.redeemAuthorizationCode({ ...redeem, authenticationContext: 'c1' }), /ASSURANCE_CONTEXT_REJECTED/);
  assert.equal(legacy.verifyPrimary, undefined);
});

test('primary resolution accepts only an exact active provisioned identity and yields no business authority', async () => {
  const client = primary();
  const events = [];
  const providerIdentity = { provider: 'microsoft_entra_platform', tenantReference: DIRECTORY, subjectReference: SUBJECT };
  let operator = { id: OPERATOR, status: 'active', securityVersion: 4, providerIdentity, roles: ['platform_security_admin'] };
  const service = createPlatformPrimaryOperatorService({ primaryClient: client,
    operatorRepository: { async findActiveByProviderIdentity(value) { assert.deepEqual(value, providerIdentity); return operator; } },
    auditService: { createUnmappedAuthenticationFailure: value => value, async record(event) { events.push(event); } } });
  const resolved = await service.resolve(await client.redeemAuthorizationCode(redeem));
  assert.deepEqual(resolved, { operatorId: OPERATOR, securityVersion: 4, providerIdentity,
    primaryAuthenticatedAt: new Date(NOW - 30_000).toISOString() });
  assert.throws(() => normalizeTrustedPlatformIdentity(resolved), /IDENTITY_FIELDS_INVALID/);
  for (const change of [null, { ...operator, status: 'disabled' }, { ...operator, securityVersion: 0 },
    { ...operator, providerIdentity: { ...providerIdentity, subjectReference: CLIENT } }]) {
    operator = change;
    await assert.rejects(service.resolve(await client.redeemAuthorizationCode(redeem)), /OPERATOR_NOT_PROVISIONED/);
  }
  assert.equal(events.length, 4);
  assert.ok(events.every(e => e.reasonCode === 'operator_not_provisioned'));
});

test('primary provider errors reveal neither raw payload nor secrets and token expiry remains enforced', async () => {
  const client = primary(tokenClaims(), { application: { ...application(), async acquireTokenByCode() {
    throw new Error('synthetic-secret-provider-payload');
  } } });
  await assert.rejects(client.redeemAuthorizationCode(redeem), error => {
    assert.equal(error.code, 'PLATFORM_ENTRA_CODE_REDEMPTION_FAILED');
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(String(error), /synthetic-secret/);
    return true;
  });
  let now = NOW;
  const expiring = primary({ ...tokenClaims(), exp: NOW / 1000 + 10 }, { clock: () => now });
  const assertion = await expiring.redeemAuthorizationCode(redeem);
  now += 11000;
  await assert.rejects(expiring.verifyPrimary(assertion), /EXPIRED/);
  await assert.rejects(primary({ ...tokenClaims(), exp: NOW / 1000 + 86401 }).redeemAuthorizationCode(redeem), /TIME_INVALID/);
});

test('Demo graphs cannot reach pending primary operator identity through an intermediary', () => {
  for (const surface of ['customer', 'platform']) {
    const violations = architectureConsolidationBoundaryViolations({
      [`src/demo/${surface}-composition.js`]: "import '../integrations/primary-proxy.js';",
      'src/integrations/primary-proxy.js': "import '../platform/identity/primary-operator-service.js';",
      'src/platform/identity/primary-operator-service.js': 'export const service = true;',
    });
    assert.ok(violations.some(value => value.includes('must not reach real Microsoft primary identity')));
  }
});
