import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_AUDIT_ACTION } from '../src/platform/audit/event.js';
import { PlatformSessionError } from '../src/platform/identity/errors.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import {
  readPlatformSessionToken,
  serializePlatformSessionCookie,
} from '../src/platform/identity/session-cookie.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ONE = '22222222-2222-4222-8222-222222222222';
const SESSION_TWO = '33333333-3333-4333-8333-333333333333';
const TOKEN_ONE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_TWO = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

function identity(overrides = {}) {
  const roles = overrides.roles || [PLATFORM_ROLE.SUPPORT_READER];
  return {
    operatorId: OPERATOR_ID,
    providerIdentity: {
      provider: 'entra_platform',
      tenantReference: 'operator-tenant',
      subjectReference: 'operator-subject',
    },
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: 1,
    targetScope: { mode: 'allowlist', securityVersion: 1 },
    assurance: {
      level: 'mfa',
      authenticationContext: 'cm-platform-mfa',
      authenticatedAt: '2026-08-28T11:55:00.000Z',
    },
    ...overrides,
  };
}

function fakeRepository() {
  const sessions = new Map();
  const auditEvents = [];
  function store(record) {
    const issuedAt = '2026-08-28T12:00:00.000Z';
    const expiresAt = '2026-08-28T16:00:00.000Z';
    const stored = {
      ...record,
      securityVersion: record.expectedSecurityVersion,
      issuedAt,
      expiresAt,
      stepUpExpiresAt: record.assurance.level === 'step_up' ? '2026-08-28T12:04:00.000Z' : null,
    };
    sessions.set(record.tokenHash, stored);
    return stored;
  }
  return {
    sessions,
    auditEvents,
    async issue(record, eventFactory) {
      const stored = store(record);
      auditEvents.push(...eventFactory(stored));
      return stored;
    },
    async resolveByTokenHash(hash, epoch) {
      const stored = sessions.get(hash);
      return stored && stored.securityEpoch === epoch && !stored.revoked ? stored : null;
    },
    async revoke({ sessionId, eventFactory }) {
      const stored = [...sessions.values()].find((entry) => entry.id === sessionId && !entry.revoked);
      if (!stored) return false;
      stored.revoked = true;
      auditEvents.push(eventFactory('2026-08-28T12:01:00.000Z'));
      return true;
    },
    async rotate({ currentSessionId, session, eventFactory }) {
      const current = [...sessions.values()].find((entry) => entry.id === currentSessionId && !entry.revoked);
      if (!current) return null;
      current.revoked = true;
      const stored = store(session);
      auditEvents.push(eventFactory(stored));
      return stored;
    },
  };
}

function service(repository, { epoch = 7, tokens = [TOKEN_ONE], ids = [SESSION_ONE] } = {}) {
  return createPlatformSessionService({
    repository,
    publicOrigin: 'https://platform.example',
    csrfSecret: 'platform-csrf-test-secret-material-32-bytes',
    securityEpoch: epoch,
    clock: () => NOW,
    tokenFactory: () => tokens.shift(),
    idFactory: () => ids.shift(),
  });
}

test('Platform cookie is independently named/scoped and rejects duplicate or customer cookies', () => {
  const cookie = serializePlatformSessionCookie(TOKEN_ONE, { secure: true, maxAgeSeconds: 3600 });
  assert.match(cookie, /^cm_platform_session=/);
  assert.match(cookie, /Path=\/api\/v1\/platform/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/);
  assert.equal(readPlatformSessionToken({ cookie: `cm_session=${TOKEN_TWO}` }), null);
  assert.equal(readPlatformSessionToken({ cookie: `cm_session=${TOKEN_TWO}; ${cookie.split(';')[0]}` }), TOKEN_ONE);
  assert.equal(readPlatformSessionToken({ cookie: `cm_platform_session=${TOKEN_ONE}; cm_platform_session=${TOKEN_TWO}` }), null);
});

test('Platform session stores only epoch-domain-separated hashes and uses independent CSRF', async () => {
  const repository = fakeRepository();
  const sessions = service(repository);
  const issued = await sessions.issue(identity(), { correlationId: CORRELATION_ID });
  const storedJson = JSON.stringify([...repository.sessions.values()]);
  assert.doesNotMatch(storedJson, new RegExp(TOKEN_ONE));
  assert.deepEqual(repository.auditEvents.slice(0, 2).map((event) => event.action), [
    PLATFORM_AUDIT_ACTION.AUTHENTICATION_SUCCEEDED,
    PLATFORM_AUDIT_ACTION.SESSION_ISSUED,
  ]);
  assert.doesNotMatch(JSON.stringify(repository.auditEvents), new RegExp(TOKEN_ONE));
  assert.doesNotMatch(JSON.stringify(repository.auditEvents), new RegExp(SESSION_ONE));

  const request = { headers: { cookie: issued.setCookie.split(';')[0] } };
  const resolved = await sessions.resolvePrincipal(request);
  assert.equal(resolved.operatorId, OPERATOR_ID);
  assert.equal(resolved.session.securityEpoch, 7);
  assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': issued.csrfToken } }, resolved), true);
  assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': TOKEN_TWO } }, resolved), false);

  const restoredDeployment = service(repository, { epoch: 8, tokens: [TOKEN_TWO], ids: [SESSION_TWO] });
  assert.equal(await restoredDeployment.resolvePrincipal(request), null);
});

test('normal rotation cannot upgrade assurance while explicit step-up rotates and revokes atomically', async () => {
  const repository = fakeRepository();
  const sessions = service(repository, { tokens: [TOKEN_ONE, TOKEN_TWO], ids: [SESSION_ONE, SESSION_TWO] });
  const issued = await sessions.issue(identity());
  const steppedUp = identity({
    assurance: {
      level: 'step_up',
      authenticationContext: 'cm-platform-step-up',
      authenticatedAt: '2026-08-28T11:59:00.000Z',
    },
  });
  await assert.rejects(sessions.rotate(issued.principal, steppedUp), PlatformSessionError);
  const elevated = await sessions.rotate(issued.principal, steppedUp, {
    purpose: 'step_up',
    correlationId: CORRELATION_ID,
  });
  assert.equal(elevated.principal.assurance.level, 'step_up');
  assert.equal(await sessions.resolvePrincipal({ headers: { cookie: issued.setCookie.split(';')[0] } }), null);
  assert.equal(repository.auditEvents.at(-1).action, PLATFORM_AUDIT_ACTION.SESSION_ROTATED);
  assert.equal(await sessions.revoke(elevated.principal), true);
});

test('session issuance rejects stale authentication and customer-shaped identities', async () => {
  const sessions = service(fakeRepository());
  await assert.rejects(sessions.issue(identity({
    assurance: { ...identity().assurance, authenticatedAt: '2026-08-28T10:00:00.000Z' },
  })), PlatformSessionError);
  await assert.rejects(sessions.issue({ ...identity(), tenantId: OPERATOR_ID }));
  assert.throws(() => createPlatformSessionService({
    repository: fakeRepository(),
    publicOrigin: 'http://platform.example',
    csrfSecret: 'platform-csrf-test-secret-material-32-bytes',
    securityEpoch: 7,
  }), /PLATFORM_PUBLIC_ORIGIN_INVALID/);
  assert.throws(() => createPlatformSessionService({
    repository: fakeRepository(),
    publicOrigin: 'https://platform.example/path',
    csrfSecret: 'platform-csrf-test-secret-material-32-bytes',
    securityEpoch: 7,
  }), /PLATFORM_PUBLIC_ORIGIN_INVALID/);
  assert.throws(() => createPlatformSessionService({
    repository: fakeRepository(),
    publicOrigin: 'https://platform.example',
    csrfSecret: 'platform-csrf-test-secret-material-32-bytes',
    securityEpoch: 7,
    stepUpTtlSeconds: 301,
  }), /PLATFORM_STEP_UP_TTL_INVALID/);
});
