import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash,randomUUID } from 'node:crypto';
import { PLATFORM_AUDIT_ACTION } from '../src/platform/audit/event.js';
import { PlatformSessionError } from '../src/platform/identity/errors.js';
import { PLATFORM_ROLE, permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import {
  readPlatformSessionToken,
  serializePlatformSessionCookie,
} from '../src/platform/identity/session-cookie.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createProtectedPlatformSessions } from '../src/platform/identity/protected-platform-sessions.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

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

const PROTECTED_EPOCH='b1000000-0000-4000-8000-000000000001';
const NEXT_PROTECTED_EPOCH='b1000000-0000-4000-8000-000000000002';
function protectedSessions(repository,overrides={}) {
  return createProtectedPlatformSessions({ repository,environment: 'int',protectedSecurityEpoch: PROTECTED_EPOCH,
    publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48),securityEpoch: 7,clock: ()=>NOW,
    tokenFactory: ()=>TOKEN_ONE,idFactory: randomUUID,...overrides });
}
function microsoftIdentity(overrides={}) {
  return identity({ providerIdentity: { ...identity().providerIdentity,provider: PLATFORM_ENTRA_PROVIDER },...overrides });
}
const cookieRequest=value=>({ headers: { cookie: value.setCookie.split(';')[0] } });

test('protected Platform sessions isolate identical tokens across legacy, environments and both independent epochs',async()=>{
  const repository=fakeRepository(),legacy=service(repository),current=protectedSessions(repository);
  const old=await legacy.issue(microsoftIdentity()),issued=await current.issue(microsoftIdentity());
  assert.ok(repository.sessions.has(createHash('sha256').update(`platform-session:v1:7:${TOKEN_ONE}`).digest('hex')));
  assert.ok(repository.sessions.has(createHash('sha256')
    .update(`platform-session:v1:7:protected-v1:int:${PROTECTED_EPOCH}:${TOKEN_ONE}`).digest('hex')));
  assert.deepEqual(await legacy.resolvePrincipal(cookieRequest(issued)),old.principal);
  // Both browsers intentionally present the same opaque token. Each service
  // resolves only its own distinct row, never the row from another namespace.
  assert.equal((await current.resolvePrincipal(cookieRequest(old))).session.id,issued.principal.session.id);
  assert.notEqual(issued.principal.session.id,old.principal.session.id);
  for (const overrides of [{ environment: 'dev' },{ environment: 'prod' },
    { protectedSecurityEpoch: NEXT_PROTECTED_EPOCH },{ securityEpoch: 8 }]) {
    assert.equal(await protectedSessions(repository,overrides).resolvePrincipal(cookieRequest(issued)),null);
  }
  const onlyProtected=fakeRepository(),isolated=await protectedSessions(onlyProtected).issue(microsoftIdentity());
  assert.equal(await service(onlyProtected).resolvePrincipal(cookieRequest(isolated)),null);
  const onlyLegacy=fakeRepository(),prior=await service(onlyLegacy).issue(microsoftIdentity());
  assert.equal(await protectedSessions(onlyLegacy).resolvePrincipal(cookieRequest(prior)),null);
  assert.equal(await current.verifyCsrf({ headers: { 'x-csrf-token': issued.csrfToken } },issued.principal),true);
  assert.equal(await current.verifyCsrf({ headers: { 'x-csrf-token': old.csrfToken } },issued.principal),false);
});

test('protected Platform issuance and resolution reject Customer or Demo providers without session or audit writes',async()=>{
  const repository=fakeRepository(),current=protectedSessions(repository);
  for (const provider of ['microsoft_entra','demo_platform','entra_platform','email_code']) {
    await assert.rejects(async()=>current.issue(identity({ providerIdentity: { ...identity().providerIdentity,provider } })),
      /PROTECTED_PLATFORM_SESSION_PROVIDER_DENIED/);
  }
  assert.equal(repository.sessions.size,0);assert.equal(repository.auditEvents.length,0);
  const issued=await current.issue(microsoftIdentity());
  const row=[...repository.sessions.values()][0];
  row.providerIdentity={ ...row.providerIdentity,provider: 'microsoft_entra' };
  assert.equal(await current.resolvePrincipal(cookieRequest(issued)),null);
  await assert.rejects(async()=>current.rotate({ ...issued.principal,providerIdentity: row.providerIdentity },microsoftIdentity()),
    /PROTECTED_PLATFORM_SESSION_PROVIDER_DENIED/);
  assert.equal(repository.sessions.size,1);
});

test('protected Platform rotation retains namespace, revokes old sessions and preserves temporary step-up semantics',async()=>{
  const repository=fakeRepository(),tokens=[TOKEN_ONE,TOKEN_TWO];
  const current=protectedSessions(repository,{ tokenFactory: ()=>tokens.shift() });
  const issued=await current.issue(microsoftIdentity());
  const identity=microsoftIdentity({ assurance: { level: 'step_up',authenticationContext: 'cm:pk:v1',
    authenticatedAt: '2026-08-28T11:59:00.000Z' } });
  const elevated=await current.rotate(issued.principal,identity,{ purpose: 'step_up' });
  assert.equal(await current.resolvePrincipal(cookieRequest(issued)),null);
  assert.equal((await current.resolvePrincipal(cookieRequest(elevated))).assurance.level,'step_up');
  assert.ok(repository.sessions.has(createHash('sha256')
    .update(`platform-session:v1:7:protected-v1:int:${PROTECTED_EPOCH}:${TOKEN_TWO}`).digest('hex')));
  await current.revoke(elevated.principal);
  assert.equal(await current.resolvePrincipal(cookieRequest(elevated)),null);
});

test('protected Platform namespace input is closed and canonical without changing legacy defaults',()=>{
  for (const environment of ['demo','test','INT',null,undefined]) {
    assert.throws(()=>protectedSessions(fakeRepository(),{ environment }),/NAMESPACE_INVALID/);
  }
  for (const protectedSecurityEpoch of ['legacy',null,undefined,'00000000-0000-0000-0000-000000000000']) {
    assert.throws(()=>protectedSessions(fakeRepository(),{ protectedSecurityEpoch }),/NAMESPACE_INVALID/);
  }
  for (const securityNamespace of ['demo','',false,'protected-v1:int:legacy']) {
    assert.throws(()=>createPlatformSessionService({ repository: fakeRepository(),publicOrigin: 'https://127.0.0.1',
      csrfSecret: 's'.repeat(48),securityEpoch: 7,securityNamespace }),/PLATFORM_SESSION_NAMESPACE_INVALID/);
  }
});
