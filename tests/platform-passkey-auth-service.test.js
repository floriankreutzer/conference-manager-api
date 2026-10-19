import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { readPlatformPasskeyTransactionCookie, serializePlatformPasskeyTransactionCookie,
  clearPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const roles = ['platform_security_admin'];
const now = new Date().toISOString();
const providerIdentity = { provider: 'microsoft_entra_platform', tenantReference: 'directory', subjectReference: 'operator' };
function principal() {
  return { operatorId: OPERATOR, securityVersion: 4, providerIdentity, roles, permissions: permissionsForPlatformRoles(roles),
    targetScope: { mode: 'all', securityVersion: 4 },
    assurance: { level: 'mfa', authenticationContext: 'cm:pk:v1', authenticatedAt: now },
    session: { id: SESSION, securityVersion: 4, securityEpoch: 7, issuedAt: now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(), stepUpExpiresAt: null } };
}

function fixture() {
  const calls = { primary: 0, issue: [], rotate: [], revoke: [], authenticate: 0, find: 0 };
  const records = new Map();
  let current = principal(); let credentialIds = [randomBytes(32).toString('base64url')];
  const repository = {
    async listActiveCredentialIds() { return credentialIds; },
    async create(record) { records.set(record.stateHash, record); return true; },
    async findPending(lookup) {
      calls.find += 1;
      const record = records.get(lookup.stateHash);
      if (!record || record.browserHash !== lookup.browserHash || record.environment !== lookup.environment
        || record.securityEpoch !== lookup.securityEpoch) return null;
      const { id, stateHash, browserHash, ttlSeconds, ...pending } = record;
      return pending;
    },
    async authenticate(value, work) {
      calls.authenticate += 1;
      if (!value.response.valid || !records.has(value.stateHash)) return null;
      const result = await work({ operatorId: OPERATOR, securityVersion: 4, purpose: value.purpose, roles,
        scopeMode: 'all', providerIdentity, expectedSessionId: value.expectedSessionId, operationHash: value.operationHash,
        authenticatedAt: now, correlationId: randomUUID() });
      records.delete(value.stateHash);
      return result;
    },
  };
  const primaryOperatorService = { async resolve(assertion) {
    calls.primary += 1;
    if (assertion !== 'verified-primary') throw new Error('PRIMARY_REJECTED');
    return { operatorId: OPERATOR, securityVersion: 4, providerIdentity, primaryAuthenticatedAt: now };
  } };
  const sessionService = {
    async issue(identity) { calls.issue.push(identity); return { principal: identity, csrfToken: 'csrf', setCookie: 'session-cookie' }; },
    async rotate(previous, identity) {
      calls.rotate.push({ previous, identity });
      return { principal: identity, csrfToken: 'csrf', setCookie: 'rotated-cookie' };
    },
    async revoke(value) { calls.revoke.push(value); return true; },
    async resolvePrincipal() { return current; },
  };
  const service = createPlatformPasskeyAuthService({ repository, primaryOperatorService, sessionService,
    verifier: { createChallenge: () => randomBytes(32).toString('base64url'),
      authenticationOptions: async value => ({ ...value, userVerification: 'required' }) },
    environment: 'int', securityEpoch: 7, transactionSecret: 's'.repeat(48) });
  return { service, records, calls, setCurrent: value => { current = value; },
    removeKeys: () => { credentialIds = []; } };
}
const cookie = result => readPlatformPasskeyTransactionCookie({ cookie: result.setCookie.split(';')[0] });

test('Microsoft primary resolution starts a browser-bound ceremony without issuing a business session', async () => {
  const f = fixture();
  await assert.rejects(f.service.startLogin('browser-claims'), /PRIMARY_REJECTED/);
  assert.equal(f.records.size, 0);
  const started = await f.service.startLogin('verified-primary');
  assert.equal(started.status, 'passkey_required');
  assert.equal(f.calls.issue.length, 0);
  assert.equal(f.calls.rotate.length, 0);
  assert.match(started.setCookie, /Path=\/api\/v1\/platform\/auth\/passkey; HttpOnly; Secure; SameSite=Strict; Max-Age=120/);
  const stored = [...f.records.values()][0];
  assert.notEqual(stored.stateHash, started.state);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(cookie(started)));
  assert.equal(stored.operatorId, OPERATOR);
  assert.equal(stored.purpose, 'login');
  assert.equal(stored.expectedSessionId, null);
  const options = await f.service.authenticationOptions(cookie(started));
  assert.equal(options.state, started.state);
  assert.equal(options.options.challenge, started.options.challenge);
  assert.equal(Object.hasOwn(options, 'operatorId'), false);
});

test('only verified repository proof becomes current server identity and a session; replay fails', async () => {
  const f = fixture();
  const started = await f.service.startLogin('verified-primary');
  const input = { cookie: cookie(started), state: started.state, response: { valid: false } };
  await assert.rejects(f.service.complete(input), /AUTHENTICATION_REJECTED/);
  assert.equal(f.calls.issue.length, 0);
  const completed = await f.service.complete({ ...input, response: { valid: true, operatorId: OTHER, roles: ['tenant_admin'] } });
  assert.equal(completed.status, 'authenticated');
  assert.deepEqual(f.calls.issue[0].roles, roles);
  assert.equal(f.calls.issue[0].operatorId, OPERATOR);
  assert.equal(f.calls.issue[0].assurance.authenticationContext, 'cm:pk:v1');
  assert.deepEqual(completed.setCookies, ['session-cookie', clearPlatformPasskeyTransactionCookie()]);
  await assert.rejects(f.service.complete({ ...input, response: { valid: true } }), /AUTHENTICATION_REJECTED/);
  assert.equal(f.calls.issue.length, 1);
});

test('wrong state, cookie signature, environment or missing enrollment cannot create authentication authority', async () => {
  const f = fixture();
  const started = await f.service.startLogin('verified-primary');
  for (const value of [null, '', `${started.state}.${'X'.repeat(43)}`, `${cookie(started)}.extra`]) {
    await assert.rejects(f.service.authenticationOptions(value), /AUTHENTICATION_REJECTED/);
  }
  await assert.rejects(f.service.complete({ cookie: cookie(started), state: 'X'.repeat(43), response: { valid: true } }),
    /AUTHENTICATION_REJECTED/);
  assert.equal(f.calls.authenticate, 0);
  f.removeKeys();
  await assert.rejects(f.service.startLogin('verified-primary'), /ENROLLMENT_REQUIRED/);
  assert.equal(f.records.size, 1);
  assert.equal(f.calls.issue.length, 0);
});

test('step-up requires the exact still-current session and operation, then rotates using fresh application assurance', async () => {
  const f = fixture();
  const operationHash = 'a'.repeat(64);
  const started = await f.service.startStepUp(principal(), { operationHash });
  assert.equal(f.calls.primary, 0);
  const stored = [...f.records.values()][0];
  assert.equal(stored.expectedSessionId, SESSION);
  assert.equal(stored.operationHash, operationHash);
  const input = { cookie: cookie(started), state: started.state, response: { valid: true }, request: {} };
  for (const current of [null, { ...principal(), operatorId: OTHER },
    { ...principal(), session: { ...principal().session, id: OTHER } }, { ...principal(), securityVersion: 5 }]) {
    f.setCurrent(current);
    await assert.rejects(f.service.executeStepUp({ ...input, operationHash }, () => true), /AUTHENTICATION_REJECTED/);
  }
  assert.equal(f.calls.authenticate, 0);
  f.setCurrent(principal());
  await assert.rejects(f.service.complete(input), /AUTHENTICATION_REJECTED/);
  await assert.rejects(f.service.executeStepUp({ ...input, operationHash: 'b'.repeat(64) }, () => true), /REJECTED/);
  const completed = await f.service.executeStepUp({ ...input, operationHash }, async context => {
    assert.equal(context.operationHash, operationHash);
    assert.equal(context.principal.assurance.level, 'step_up');
    return { changed: true };
  });
  assert.equal(completed.status, 'operation_completed');
  assert.deepEqual(completed.result, { changed: true });
  assert.equal(completed.principal.assurance.level, 'mfa');
  assert.equal(f.calls.revoke.length, 1);
  assert.equal(f.calls.rotate.length, 1);
  assert.equal(f.calls.rotate[0].identity.assurance.level, 'step_up');
  assert.equal(f.calls.issue.length, 1);
  await assert.rejects(f.service.startStepUp(principal(), { operationHash: 'browser-operation' }), /REJECTED/);
});

test('passkey cookies reject duplicates and overlong/malformed values and never expose an ambient Domain', () => {
  const value = `${'S'.repeat(43)}.${'B'.repeat(43)}`;
  const header = serializePlatformPasskeyTransactionCookie(value);
  assert.equal(readPlatformPasskeyTransactionCookie({ cookie: header.split(';')[0] }), value);
  assert.equal(readPlatformPasskeyTransactionCookie({ cookie: `${header.split(';')[0]}; ${header.split(';')[0]}` }), null);
  assert.equal(readPlatformPasskeyTransactionCookie({ cookie: 'x'.repeat(8193) }), null);
  assert.equal(readPlatformPasskeyTransactionCookie({ cookie: 'cm_platform_passkey_tx=invalid' }), null);
  assert.doesNotMatch(header, /Domain=/);
  assert.throws(() => serializePlatformPasskeyTransactionCookie(value, 301), /COOKIE_INVALID/);
});
