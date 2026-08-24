import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTrustedIdentity } from '../src/identity/principal.js';
import {
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../src/identity/session-cookie.js';
import { createSessionService, SessionServiceError } from '../src/identity/session-service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ONE = '55555555-5555-4555-8555-555555555555';
const SESSION_TWO = '66666666-6666-4666-8666-666666666666';
const TOKEN_ONE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_TWO = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CSRF_SECRET = 'csrf-secret-for-tests-only-32-bytes-minimum';

function identity(overrides = {}) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    providerIdentity: { provider: 'test_oidc', reference: 'provider-subject-123' },
    roles: ['employee'],
    permissions: ['request:read'],
    ...overrides,
  };
}

function fakeRepository({ provisioned = true } = {}) {
  const sessions = new Map();
  return {
    sessions,
    async issue(record) {
      if (!provisioned) return null;
      const stored = { ...record, securityVersion: 1, tenantStatus: 'active' };
      sessions.set(record.tokenHash, stored);
      return stored;
    },
    async resolveByTokenHash(hash, now) {
      const stored = sessions.get(hash);
      if (!stored || stored.revoked || Date.parse(stored.expiresAt) <= now.getTime()) return null;
      return stored;
    },
    async revoke({ sessionId }) {
      const stored = [...sessions.values()].find((candidate) => candidate.id === sessionId && !candidate.revoked);
      if (!stored) return false;
      stored.revoked = true;
      return true;
    },
    async rotate({ currentSessionId, session }) {
      const current = [...sessions.values()].find((candidate) => candidate.id === currentSessionId && !candidate.revoked);
      if (!current) return null;
      current.revoked = true;
      const stored = { ...session, securityVersion: 2, tenantStatus: 'active' };
      sessions.set(session.tokenHash, stored);
      return stored;
    },
  };
}

function cookiePair(setCookie) {
  return setCookie.split(';', 1)[0];
}

test('session cookie contract is narrow, HttpOnly, and fail-closed for malformed or duplicate values', () => {
  const secure = serializeSessionCookie(TOKEN_ONE, { secure: true, maxAgeSeconds: 3600 });
  assert.match(secure, /^cm_session=/);
  assert.match(secure, /Path=\/api/);
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Secure/);
  assert.doesNotMatch(secure, /Domain=/);

  assert.equal(readSessionToken({ cookie: `other=x; ${cookiePair(secure)}` }), TOKEN_ONE);
  assert.equal(readSessionToken({ cookie: `cm_session=${TOKEN_ONE}; cm_session=${TOKEN_TWO}` }), null);
  assert.equal(readSessionToken({ cookie: 'cm_session=not-valid' }), null);
  assert.equal(readSessionToken({ cookie: 'x=y' }), null);

  const cleared = serializeClearedSessionCookie({ secure: true });
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
});

test('trusted identity contract rejects provider/client-shaped malformed identities', () => {
  assert.throws(() => normalizeTrustedIdentity(identity({
    providerIdentity: { provider: 'Microsoft Entra ID', reference: 'subject' },
  })), TypeError);
  assert.throws(() => normalizeTrustedIdentity(identity({ tenantId: 'client-selected-tenant' })), TypeError);
  assert.throws(() => normalizeTrustedIdentity(identity({ roles: ['ADMIN ROLE'] })), TypeError);
  assert.throws(() => normalizeTrustedIdentity(identity({ permissions: ['bad permission'] })), TypeError);
});

test('session service stores only token hashes and resolves opaque cookies into internal principals', async () => {
  const repository = fakeRepository();
  const service = createSessionService({
    repository,
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_SECRET,
    clock: () => Date.parse('2026-08-24T06:00:00.000Z'),
    tokenFactory: () => TOKEN_ONE,
    idFactory: () => SESSION_ONE,
  });

  const issued = await service.issue(identity());
  assert.match(issued.setCookie, /Secure/);
  assert.doesNotMatch(JSON.stringify([...repository.sessions.values()]), new RegExp(TOKEN_ONE));
  assert.equal(issued.principal.providerIdentity.provider, 'test_oidc');
  assert.equal(issued.principal.session.securityVersion, 1);

  const request = { headers: { cookie: cookiePair(issued.setCookie) } };
  const resolved = await service.resolvePrincipal(request);
  assert.equal(resolved.userId, USER_ID);
  assert.equal(resolved.tenantId, TENANT_ID);
  assert.deepEqual(resolved.permissions, ['request:read']);
  assert.equal(service.csrfTokenForPrincipal(resolved), issued.csrfToken);
  assert.equal(await service.verifyCsrf({ headers: { 'x-csrf-token': issued.csrfToken } }, resolved), true);
  const wrongCsrf = `${issued.csrfToken[0] === 'A' ? 'B' : 'A'}${issued.csrfToken.slice(1)}`;
  assert.equal(await service.verifyCsrf({ headers: { 'x-csrf-token': wrongCsrf } }, resolved), false);
  assert.equal(await service.resolvePrincipal({ headers: { cookie: `cm_session=${TOKEN_ONE.slice(0, -1)}!` } }), null);
});

test('session expiry, revocation, and rotation fail closed and do not reuse session tokens', async () => {
  let now = Date.parse('2026-08-24T06:00:00.000Z');
  const repository = fakeRepository();
  const tokens = [TOKEN_ONE, TOKEN_TWO];
  const ids = [SESSION_ONE, SESSION_TWO];
  const service = createSessionService({
    repository,
    publicOrigin: 'http://localhost:3000',
    csrfSecret: CSRF_SECRET,
    sessionTtlSeconds: 300,
    clock: () => now,
    tokenFactory: () => tokens.shift(),
    idFactory: () => ids.shift(),
  });

  const first = await service.issue(identity());
  const firstRequest = { headers: { cookie: cookiePair(first.setCookie) } };
  assert.ok(await service.resolvePrincipal(firstRequest));

  const rotated = await service.rotate(first.principal, identity({ roles: ['manager'] }));
  assert.notEqual(cookiePair(rotated.setCookie), cookiePair(first.setCookie));
  assert.equal(await service.resolvePrincipal(firstRequest), null);
  const rotatedRequest = { headers: { cookie: cookiePair(rotated.setCookie) } };
  assert.deepEqual((await service.resolvePrincipal(rotatedRequest)).roles, ['manager']);

  assert.equal(await service.revoke(rotated.principal), true);
  assert.equal(await service.resolvePrincipal(rotatedRequest), null);

  now += 301_000;
  assert.equal(await service.resolvePrincipal(rotatedRequest), null);
});

test('session issuance and rotation reject unprovisioned or mismatched trusted identities', async () => {
  const unavailable = createSessionService({
    repository: fakeRepository({ provisioned: false }),
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_SECRET,
    tokenFactory: () => TOKEN_ONE,
    idFactory: () => SESSION_ONE,
  });
  await assert.rejects(unavailable.issue(identity()), (error) => {
    return error instanceof SessionServiceError && error.code === 'IDENTITY_NOT_PROVISIONED';
  });

  const service = createSessionService({
    repository: fakeRepository(),
    publicOrigin: 'https://conference.example',
    csrfSecret: CSRF_SECRET,
    tokenFactory: () => TOKEN_ONE,
    idFactory: () => SESSION_ONE,
  });
  const issued = await service.issue(identity());
  await assert.rejects(service.rotate(issued.principal, identity({
    tenantId: '33333333-3333-4333-8333-333333333333',
  })), (error) => {
    return error instanceof SessionServiceError && error.code === 'SESSION_ROTATION_SUBJECT_MISMATCH';
  });
});
