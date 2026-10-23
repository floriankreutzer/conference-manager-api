import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { readPlatformPasskeyTransactionCookie, serializePlatformPasskeyTransactionCookie,
  clearPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { serializePlatformPasskeyEnrollmentCookie } from '../src/platform/identity/passkey-enrollment-cookie.js';

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

function fixture({ allowBusinessLogin = true, minimumCredentialCount = 1,withSessionState=false } = {}) {
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
    async consumeEnrollmentPrimary(lookup, work) {
      const record = records.get(lookup.stateHash);
      if (!record || record.purpose !== 'enroll' || record.browserHash !== lookup.browserHash
        || record.environment !== lookup.environment || record.securityEpoch !== lookup.securityEpoch) return null;
      const result = await work({ operatorId: OPERATOR, securityVersion: 4, providerIdentity,
        primaryAuthenticatedAt: record.primaryAuthenticatedAt });
      records.delete(lookup.stateHash); return result;
    },
  };
  const primaryOperatorService = { async resolve(assertion) {
    calls.primary += 1;
    if (assertion !== 'verified-primary') throw new Error('PRIMARY_REJECTED');
    return { operatorId: OPERATOR, securityVersion: 4, providerIdentity, primaryAuthenticatedAt: now };
  } };
  function issuedPrincipal(identity) {
    return withSessionState ? { ...identity,session: { ...principal().session,id: randomUUID(),
      stepUpExpiresAt: identity.assurance.level==='step_up'
        ? new Date(Date.parse(identity.assurance.authenticatedAt)+300_000).toISOString() : null } } : identity;
  }
  const sessionService = {
    async issue(identity) {
      calls.issue.push(identity);return { principal: issuedPrincipal(identity), csrfToken: 'csrf', setCookie: 'session-cookie' };
    },
    async rotate(previous, identity) {
      calls.rotate.push({ previous, identity });
      return { principal: issuedPrincipal(identity), csrfToken: 'csrf', setCookie: 'rotated-cookie' };
    },
    async revoke(value) { calls.revoke.push(value); return true; },
    async resolvePrincipal() { return current; },
  };
  const service = createPlatformPasskeyAuthService({ repository, primaryOperatorService, sessionService,
    verifier: { createChallenge: () => randomBytes(32).toString('base64url'),
      authenticationOptions: async value => ({ ...value, userVerification: 'required' }) },
    environment: 'int', securityEpoch: 7, transactionSecret: 's'.repeat(48), allowBusinessLogin, minimumCredentialCount });
  return { service, records, calls, setCurrent: value => { current = value; },
    removeKeys: () => { credentialIds = []; }, setKeys: values => { credentialIds = values; } };
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
  const enrollment = await f.service.startLogin('verified-primary');
  assert.equal(enrollment.status, 'enrollment_required');
  assert.equal(Object.hasOwn(enrollment, 'options'), false);
  assert.equal((await f.service.pendingAuthentication(cookie(enrollment))).status, 'enrollment_required');
  await assert.rejects(f.service.complete({ cookie: cookie(enrollment), state: enrollment.state, response: { valid: true } }),
    /AUTHENTICATION_REJECTED/);
  assert.equal(f.records.size, 2);
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

test('credential lifecycle finishes its verified operation with logout and never issues an obsolete-version session', async () => {
  const f = fixture(); const operationHash = 'c'.repeat(64);
  const started = await f.service.startStepUp(principal(), { operationHash });
  const input = { cookie: cookie(started), state: started.state, response: { valid: true }, request: {}, operationHash };
  const completed = await f.service.executeCredentialLifecycle(input, async context => {
    assert.equal(context.principal.assurance.level, 'step_up');
    assert.equal(context.operationHash, operationHash);
    return { status: 'credential_revoked' };
  });
  assert.equal(completed.status, 'reauthentication_required');
  assert.deepEqual(completed.result, { status: 'credential_revoked' });
  assert.equal(Object.hasOwn(completed, 'principal'), false);
  assert.equal(Object.hasOwn(completed, 'csrfToken'), false);
  assert.match(completed.setCookies[0], /cm_platform_session=;.*Secure; Max-Age=0/);
  assert.equal(f.calls.issue.length, 0);
  assert.equal(f.calls.rotate.length, 1);
  assert.equal(f.calls.revoke.length, 1);
  await assert.rejects(f.service.executeCredentialLifecycle(input, () => true), /AUTHENTICATION_REJECTED/);
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

test('durable pending Microsoft identity is separately one-use and cannot be redeemed as a business login', async () => {
  const f = fixture(); f.removeKeys();
  const started = await f.service.startLogin('verified-primary');
  assert.equal(started.status, 'enrollment_required');
  const input = { cookie: cookie(started), state: started.state };
  await assert.rejects(f.service.consumeEnrollmentPrimary({ ...input, state: 'foreign' }, () => true), /REJECTED/);
  const result = await f.service.consumeEnrollmentPrimary(input, async value => {
    assert.equal(value.operatorId, OPERATOR); assert.equal(value.securityVersion, 4);
    assert.equal(Object.hasOwn(value, 'roles'), false); return { started: true };
  });
  assert.deepEqual(result, { started: true });
  await assert.rejects(f.service.consumeEnrollmentPrimary(input, () => true), /REJECTED/);
  assert.equal(f.calls.issue.length, 0);
});

test('setup-only login can issue only an internal temporary strong session for the next registration', async () => {
  const f = fixture({ allowBusinessLogin: false, minimumCredentialCount: 2 });
  const started = await f.service.startLogin('verified-primary');
  const input = { cookie: cookie(started), state: started.state, response: { valid: true } };
  assert.equal((await f.service.pendingAuthentication(input.cookie)).setupRequired, true);
  await assert.rejects(f.service.complete(input), /SETUP_REQUIRED/);
  assert.equal(f.calls.issue.length, 0);
  const state = randomBytes(32).toString('base64url'); const browser = randomBytes(32).toString('base64url');
  const registration = { status: 'registration_required', state, options: {},
    setCookie: serializePlatformPasskeyEnrollmentCookie(`${state}.${browser}`) };
  const result = await f.service.executeSetupLogin(input, async ({ principal }) => {
    assert.equal(principal.assurance.level, 'step_up'); return registration;
  });
  assert.deepEqual(result, registration);
  assert.equal(Object.hasOwn(result, 'principal'), false);
  assert.equal(f.calls.issue.length, 1); assert.equal(f.calls.issue[0].assurance.level, 'step_up');
  assert.equal(f.calls.revoke.length, 1);
  assert.doesNotMatch(result.setCookie, /cm_platform_session/);
});

test('two completed keys finish setup without a session; active login separately requires the configured key minimum', async () => {
  const f = fixture({ allowBusinessLogin: false, minimumCredentialCount: 2 });
  const ids = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]; f.setKeys(ids);
  const started = await f.service.startLogin('verified-primary');
  const input = { cookie: cookie(started), state: started.state, response: { valid: true } };
  const result = await f.service.executeSetupLogin(input, () => { throw new Error('unexpected issuance'); });
  assert.equal(result.status, 'setup_complete'); assert.equal(f.calls.issue.length, 0);
  const active = fixture({ minimumCredentialCount: 2 });
  const pending = await active.service.startLogin('verified-primary');
  const proof = { cookie: cookie(pending), state: pending.state, response: { valid: true } };
  await assert.rejects(active.service.complete(proof), /SETUP_REQUIRED/);
  active.setKeys(ids);
  assert.equal((await active.service.complete(proof)).status, 'authenticated');
  assert.equal(active.calls.issue[0].assurance.level, 'mfa');
});

test('setup callback cannot smuggle a session, another cookie scope or unknown response authority', async () => {
  for (const change of [{ principal: principal() }, { setCookie: 'cm_platform_session=forbidden' },
    { setCookie: `cm_platform_passkey_enroll=${'S'.repeat(43)}.${'B'.repeat(43)}; Domain=foreign.example.com` }]) {
    const f = fixture({ allowBusinessLogin: false,minimumCredentialCount: 2 });
    const started = await f.service.startLogin('verified-primary');
    await assert.rejects(f.service.executeSetupLogin({ cookie: cookie(started), state: started.state, response: { valid: true } },
      async () => ({ status: 'registration_required', state: 'S'.repeat(43), options: {},
        setCookie: serializePlatformPasskeyEnrollmentCookie(`${'S'.repeat(43)}.${'B'.repeat(43)}`), ...change })), /REJECTED/);
  }
});

test('operation context is opaque, transaction-lifetime-bound, exact-hash and one-use for HTTP authorization', async () => {
  const f = fixture(); const operationHash = 'd'.repeat(64);
  const started = await f.service.startStepUp(principal(), { operationHash }); let captured;
  await f.service.executeStepUp({ cookie: cookie(started), state: started.state, response: { valid: true }, request: {}, operationHash },
    async context => {
      captured = context;
      assert.throws(() => f.service.verifiedOperationPrincipal({ ...context }, operationHash), /REJECTED/);
      assert.equal(f.service.verifiedOperationPrincipal(context, operationHash).assurance.level, 'step_up');
      assert.throws(() => f.service.verifiedOperationPrincipal(context, operationHash), /REJECTED/);
      return { changed: true };
    });
  assert.throws(() => f.service.verifiedOperationPrincipal(captured, operationHash), /REJECTED/);
});

test('explicit continuation binds the future normal session privately before mutation; no temporary cookie escapes',async()=>{
  const f=fixture({ minimumCredentialCount: 2,withSessionState: true }),operationHash='e'.repeat(64);
  f.setKeys([randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')]);
  const started=await f.service.startStepUp(principal(),{ operationHash });let captured,continuation,temporary;
  const result=await f.service.executeStepUpWithContinuation({ cookie: cookie(started),state: started.state,
    response: { valid: true },request: {},operationHash },async context=>{
    captured=context;assert.equal(f.calls.issue.length,1);assert.equal(f.calls.revoke.length,0);
    assert.throws(()=>f.service.verifiedOperationWithContinuation({ ...context },operationHash),/REJECTED/);
    const authority=f.service.verifiedOperationWithContinuation(context,operationHash);
    continuation=authority.continuationPrincipal;temporary=authority.principal;
    assert.equal(temporary.assurance.level,'step_up');assert.equal(continuation.assurance.level,'mfa');
    assert.notEqual(continuation.session.id,SESSION);assert.notEqual(continuation.session.id,temporary.session.id);
    assert.throws(()=>f.service.verifiedOperationPrincipal(context,operationHash),/REJECTED/);
    return { approved: true };
  });
  assert.equal(result.principal.session.id,continuation.session.id);assert.equal(result.principal.assurance.level,'mfa');
  assert.deepEqual(f.calls.revoke.map(value=>value.session.id),[temporary.session.id]);
  assert.equal(f.calls.issue.length,1);assert.doesNotMatch(result.setCookies.join('\n'),/rotated-cookie/);
  assert.throws(()=>f.service.verifiedOperationWithContinuation(captured,operationHash),/REJECTED/);
});

test('continuation rejects setup mode and enforces the configured two distinct active credentials',async()=>{
  for (const config of [{ allowBusinessLogin: false,minimumCredentialCount: 1 },{ allowBusinessLogin: false,minimumCredentialCount: 2 }]) {
    const f=fixture(config);
    await assert.rejects(f.service.executeStepUpWithContinuation({ operationHash: 'f'.repeat(64) },async()=>({})),/SETUP_REQUIRED/);
    assert.equal(f.calls.authenticate,0);assert.equal(f.calls.issue.length,0);
  }
  for (const duplicate of [false,true]) {
    const f=fixture({ minimumCredentialCount: 2,withSessionState: true }),operationHash='e'.repeat(64);
    const id=randomBytes(32).toString('base64url');f.setKeys(duplicate ? [id,id] : [id]);
    const started=await f.service.startStepUp(principal(),{ operationHash });let calls=0;
    await assert.rejects(f.service.executeStepUpWithContinuation({ cookie: cookie(started),state: started.state,
      response: { valid: true },request: {},operationHash },async()=>{ calls++;return {}; }),/SETUP_REQUIRED/);
    assert.equal(calls,0);assert.equal(f.calls.issue.length,0);assert.equal(f.calls.rotate.length,0);
  }
});

test('ordinary step-up has no continuation authority and failed continuation mutation expires its context',async()=>{
  const ordinary=fixture(),operationHash='a'.repeat(64);
  const first=await ordinary.service.startStepUp(principal(),{ operationHash });
  await assert.rejects(ordinary.service.executeStepUp({ cookie: cookie(first),state: first.state,response: { valid: true },
    request: {},operationHash },async context=>ordinary.service.verifiedOperationWithContinuation(context,operationHash)),/REJECTED/);
  const f=fixture({ minimumCredentialCount: 2,withSessionState: true });
  f.setKeys([randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')]);
  const next=await f.service.startStepUp(principal(),{ operationHash });let captured;
  await assert.rejects(f.service.executeStepUpWithContinuation({ cookie: cookie(next),state: next.state,
    response: { valid: true },request: {},operationHash },async context=>{
    captured=context;throw new Error('SYNTHETIC_MUTATION_FAILED');
  }),/SYNTHETIC_MUTATION_FAILED/);
  assert.throws(()=>f.service.verifiedOperationWithContinuation(captured,operationHash),/REJECTED/);
});


test('explicit INT one-key setup finishes only after a real proof and never issues a business session',async()=>{
  const f=fixture({ allowBusinessLogin: false,minimumCredentialCount: 1 });
  const started=await f.service.startLogin('verified-primary');
  const input={ cookie: cookie(started),state: started.state,response: { valid: true } };
  await assert.rejects(f.service.executeSetupLogin({ ...input,response: { valid: false } },()=>assert.fail()),/REJECTED/);
  await assert.rejects(f.service.complete(input),/SETUP_REQUIRED/);
  const result=await f.service.executeSetupLogin(input,()=>assert.fail('NO_SECOND_KEY_ISSUANCE'));
  assert.equal(result.status,'setup_complete');assert.equal(f.calls.issue.length,0);
  await assert.rejects(f.service.executeSetupLogin(input,()=>assert.fail()),/REJECTED/);
});

test('INT one-key login does not relax the separate synthetic continuation two-key contract',async()=>{
  const f=fixture({ minimumCredentialCount: 1,withSessionState: true });
  await assert.rejects(f.service.executeStepUpWithContinuation({ operationHash: 'e'.repeat(64) },()=>assert.fail()),/SETUP_REQUIRED/);
  assert.equal(f.calls.authenticate,0);assert.equal(f.calls.issue.length,0);assert.equal(f.calls.rotate.length,0);
});
