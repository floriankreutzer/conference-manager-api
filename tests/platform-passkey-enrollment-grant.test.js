import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createPlatformPasskeyEnrollmentGrant,
  normalizePlatformPasskeyEnrollmentGrantClaim } from '../src/platform/identity/passkey-enrollment-grant.js';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CORRELATION = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const identity = { provider: 'microsoft_entra_platform', tenantReference: CORRELATION, subjectReference: OTHER };
const binding = { operatorId: OPERATOR, operatorSecurityVersion: 4, providerIdentity: identity, environment: 'int', securityEpoch: 8 };
const record = () => ({ ...binding, kind: 'bootstrap', approvalReference: 'CM-INT-OWNER-001', issuedFromSessionId: null,
  correlationId: CORRELATION, ttlSeconds: 600 });

test('enrollment grants produce only bounded random opaque capability and hash-only exact-identity persistence', () => {
  const first = createPlatformPasskeyEnrollmentGrant(record());
  const second = createPlatformPasskeyEnrollmentGrant(record());
  assert.notEqual(first.grant.grantId, second.grant.grantId);
  assert.notEqual(first.grant.token, second.grant.token);
  assert.equal(Buffer.from(first.grant.token, 'base64url').length, 32);
  const claim = normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, ...first.grant });
  assert.equal(claim.tokenHash, first.record.tokenHash);
  assert.doesNotMatch(JSON.stringify(first.record), new RegExp(first.grant.token));
  assert.equal(Object.hasOwn(first.record, 'assurance'), false);
  assert.equal(Object.hasOwn(first.record, 'roles'), false);
  assert.equal(Object.hasOwn(first.record, 'expiresAt'), false); // Authoritative expiry belongs to the database clock.
  for (const change of [{ environment: 'dev' }, { securityEpoch: 9 }, { grantId: OTHER }, { operatorId: OTHER },
    { operatorSecurityVersion: 5 }, { providerIdentity: { ...identity, subjectReference: OPERATOR } }]) {
    assert.notEqual(normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, ...first.grant, ...change }).tokenHash,
      first.record.tokenHash);
  }
});

test('grant policy distinguishes independent bootstrap/recovery issuance from strong-session additions', () => {
  for (const kind of ['bootstrap', 'recovery']) {
    assert.equal(createPlatformPasskeyEnrollmentGrant({ ...record(), kind, ttlSeconds: 900 }).record.kind, kind);
    assert.throws(() => createPlatformPasskeyEnrollmentGrant({ ...record(), kind, issuedFromSessionId: OTHER }), /GRANT_INVALID/);
  }
  const additional = { ...record(), kind: 'additional', issuedFromSessionId: OTHER, ttlSeconds: 300 };
  assert.equal(createPlatformPasskeyEnrollmentGrant(additional).record.kind, 'additional');
  assert.throws(() => createPlatformPasskeyEnrollmentGrant({ ...additional, issuedFromSessionId: null }), /GRANT_INVALID/);
  assert.throws(() => createPlatformPasskeyEnrollmentGrant({ ...additional, ttlSeconds: 301 }), /GRANT_INVALID/);
});

test('unknown authority fields, email identities, aliases, malformed tokens and excessive lifetime fail closed', () => {
  for (const change of [{ roles: ['platform_security_admin'] }, { kind: 'email_recovery' }, { ttlSeconds: 901 },
    { ttlSeconds: 59 }, { environment: 'demo' }, { securityEpoch: 0 }, { operatorSecurityVersion: 0 },
    { approvalReference: 'owner@example.com' }, { providerIdentity: { ...identity, subjectReference: 'owner@example.com' } },
    { providerIdentity: { ...identity, provider: 'customer_email_code' } }, { providerIdentity: { ...identity, email: 'ignored' } }]) {
    assert.throws(() => createPlatformPasskeyEnrollmentGrant({ ...record(), ...change }), /GRANT_INVALID/);
  }
  for (const value of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}B`, `${'a'.repeat(43)}=`, '\n'.repeat(43)]) {
    assert.throws(() => normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, grantId: CORRELATION, token: value }), /GRANT_INVALID/);
  }
  const valid = randomBytes(32).toString('base64url');
  assert.throws(() => normalizePlatformPasskeyEnrollmentGrantClaim({ ...binding, grantId: CORRELATION, token: valid,
    approved: true }), /GRANT_INVALID/);
});
