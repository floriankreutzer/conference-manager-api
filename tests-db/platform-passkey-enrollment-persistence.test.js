import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformPasskeyGrantIssuer } from '../src/persistence/postgres/platform-passkey-grant-issuer.js';
import { createPostgresPlatformPasskeyEnrollmentRepository } from '../src/persistence/postgres/platform-passkey-enrollment-repository.js';
import { createPlatformPasskeyEnrollmentService } from '../src/platform/identity/passkey-enrollment-service.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { createPlatformPasskeyLifecycleService } from '../src/platform/identity/passkey-lifecycle-service.js';
import { readPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { createPlatformPasskeyEnrollmentFlow } from '../src/platform/identity/passkey-enrollment-flow.js';
import { readPlatformPasskeyEnrollmentCookie } from '../src/platform/identity/passkey-enrollment-cookie.js';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';

test('independently granted enrollment stages public keys and atomically requires real possession before activation', async t => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  const role = (await pool.query('SELECT session_user AS role')).rows[0].role;
  const auditRepository = createPostgresPlatformAuditRepository(pool, { hmacSecret: 'a'.repeat(48) });
  const issuer = createPostgresPlatformPasskeyGrantIssuer(pool, { auditRepository, expectedOfflineRole: role });
  const verifier = createPlatformPasskeyVerifier({ publicOrigin: 'https://ops-int.example.com', environment: 'int' });
  const repository = createPostgresPlatformPasskeyEnrollmentRepository(pool, { auditRepository });
  async function setup(primaryAgeMs = 0) {
    const operatorId = randomUUID(); const directory = randomUUID(); const subject = randomUUID();
    await pool.query(`INSERT INTO platform_operators
      (id,provider,provider_tenant_reference,provider_subject_reference,roles,scope_mode)
      VALUES ($1,'microsoft_entra_platform',$2,$3,ARRAY['platform_security_admin'],'all')`, [operatorId,directory,subject]);
    const providerIdentity = { provider: 'microsoft_entra_platform', tenantReference: directory, subjectReference: subject };
    const request = { operatorId, operatorSecurityVersion: 1, providerIdentity, environment: 'int', securityEpoch: 8,
      kind: 'bootstrap', approvalReference: 'CM-INT-OWNER-001', ttlSeconds: 600, correlationId: randomUUID() };
    const primaryOperatorService = { async resolve() {
      const row = (await pool.query('SELECT security_version FROM platform_operators WHERE id = $1', [operatorId])).rows[0];
      return { operatorId, securityVersion: Number(row.security_version), providerIdentity,
        primaryAuthenticatedAt: new Date(Date.now() - primaryAgeMs).toISOString() };
    } };
    function service(port = repository) { return createPlatformPasskeyEnrollmentService({ repository: port, primaryOperatorService,
      verifier, environment: 'int', securityEpoch: 8 }); }
    async function start(grant, port = repository) {
      const started = await service(port).start({ assertion: 'verified-primary-port-fixture', grant, correlationId: randomUUID() });
      return { ...started, cookie: started.setCookie.split(';')[0].split('=')[1], service: service(port) };
    }
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials WHERE operator_id=$1',
      [operatorId])).rows[0].n;
    return { operatorId, request, service, start, count, primaryOperatorService };
  }
  function input(started, key, purpose, changes = {}) {
    const response = key.response(purpose, { ...changes, client: { challenge: started.options.challenge, ...changes.client } });
    if (purpose !== 'create') response.response.userHandle = started.userHandle;
    return { cookie: started.cookie, state: started.state, response };
  }
  async function stage(f, issued, key, port = repository) {
    const started = await f.start(issued.grant, port);
    const registered = await started.service.register(input(started, key, 'create'));
    return { ...started, ...registered, userHandle: started.options.user.id };
  }

  await t.test('no grant or Microsoft-only authority can enroll; registration alone cannot create a credential', async () => {
    const f = await setup(); const key = platformPasskeyFixture({ operatorId: f.operatorId });
    await assert.rejects(f.start({ grantId: randomUUID(), token: verifier.createChallenge() }), /ENROLLMENT_REJECTED/);
    const issued = await issuer.issueOffline(f.request);
    assert.equal(issued.operatorSecurityVersion, 1);
    const started = await stage(f, issued, key);
    assert.equal(started.status, 'possession_required');
    assert.equal(await f.count(), 0);
    const row = (await pool.query('SELECT token_hash,consumed_at FROM platform_passkey_enrollment_grants WHERE id=$1',
      [issued.grant.grantId])).rows[0];
    assert.equal(row.consumed_at, null);
    assert.notEqual(row.token_hash, issued.grant.token);
    const proof = input(started, key, 'get');
    const results = await Promise.allSettled([started.service.complete(proof), started.service.complete(proof)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await f.count(), 1);
    const current = (await pool.query('SELECT security_version FROM platform_operators WHERE id=$1', [f.operatorId])).rows[0];
    assert.equal(Number(current.security_version), 2);
    const grantRow = (await pool.query('SELECT consumed_at FROM platform_passkey_enrollment_grants WHERE id=$1',
      [issued.grant.grantId])).rows[0];
    assert.ok(grantRow.consumed_at);
    await assert.rejects(issuer.issueOffline({ ...f.request, operatorSecurityVersion: 2 }), /OFFLINE_ISSUANCE_REJECTED/);
  });

  await t.test('pending enrollment accepts the primary verifier freshness skew and rejects assertions outside that window', async () => {
    const f = await setup(330_000);
    const sessions = createPlatformSessionService({ repository: createPostgresPlatformSessionRepository(pool, { auditRepository }),
      publicOrigin: 'https://ops-int.example.com', csrfSecret: 'c'.repeat(48), securityEpoch: 8 });
    const authRepository = createPostgresPlatformPasskeyAuthRepository(pool, { verifier, auditRepository });
    const authService = createPlatformPasskeyAuthService({ repository: authRepository, primaryOperatorService: f.primaryOperatorService,
      verifier, sessionService: sessions, environment: 'int', securityEpoch: 8, transactionSecret: 't'.repeat(48),
      allowBusinessLogin: false, minimumCredentialCount: 2 });
    assert.equal((await authService.startLogin('verified-primary-skew-fixture')).status, 'enrollment_required');
    const stored = (await pool.query(`SELECT created_at,primary_authenticated_at FROM platform_passkey_auth_transactions
      WHERE operator_id=$1`, [f.operatorId])).rows[0];
    assert.ok(stored.created_at.getTime()-stored.primary_authenticated_at.getTime()>300_000);
    assert.ok(stored.created_at.getTime()-stored.primary_authenticated_at.getTime()<360_000);
    const client = await pool.connect();
    try {
      for (const [interval,allowed] of [['360 seconds',true],['360.001 seconds',false],
        ['-60 seconds',true],['-60.001 seconds',false]]) {
        await client.query('BEGIN');
        try {
          // Intervals are fixed test cases, never SQL fragments or wall-clock changes.
          const update=client.query(`UPDATE platform_passkey_auth_transactions
            SET primary_authenticated_at=created_at-$2::interval WHERE operator_id=$1`, [f.operatorId,interval]);
          if (allowed) assert.equal((await update).rowCount,1);
          else await assert.rejects(update,error => error.code==='23514'
            && error.constraint==='platform_passkey_primary_time_valid');
        } finally { await client.query('ROLLBACK'); }
      }
    } finally { client.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_sessions WHERE operator_id=$1',
      [f.operatorId])).rows[0].n,0);
  });

  await t.test('wrong browser cannot burn another ceremony; invalid proof commits a bounded attempt and denial audit', async () => {
    const f = await setup(); const key = platformPasskeyFixture({ operatorId: f.operatorId });
    const issued = await issuer.issueOffline(f.request); const started = await stage(f, issued, key);
    const wrong = input(started, key, 'get', { client: { origin: 'https://foreign.example.com' } });
    const foreignCookie = `${verifier.createChallenge()}.${verifier.createChallenge()}`;
    await assert.rejects(started.service.complete({ ...wrong, cookie: foreignCookie }), /ENROLLMENT_REJECTED/);
    const attempts = async () => (await pool.query(`SELECT possession_attempts
      FROM platform_passkey_enrollment_transactions WHERE grant_id=$1`,
      [issued.grant.grantId])).rows[0].possession_attempts;
    assert.equal(await attempts(), 0);
    for (let n = 0; n < 5; n++) await assert.rejects(started.service.complete(wrong), /ENROLLMENT_REJECTED/);
    assert.equal(await attempts(), 5);
    assert.equal(await f.count(), 0);
    await assert.rejects(started.service.complete(input(started, key, 'get')), /ENROLLMENT_REJECTED/);
    assert.equal(await attempts(), 5);
    const denied = await pool.query(`SELECT count(*)::int AS n FROM platform_audit_events
      WHERE target_type='platform_passkey_enrollment' AND outcome='denied'`);
    assert.equal(denied.rows[0].n, 5);
  });

  await t.test('audit failure rolls back grant redemption, possession attempt, key insertion and managed operator version', async () => {
    const f = await setup(); const key = platformPasskeyFixture({ operatorId: f.operatorId });
    const issued = await issuer.issueOffline(f.request);
    const failing = createPostgresPlatformPasskeyEnrollmentRepository(pool,
      { auditRepository: { async appendWithClient() { throw new Error('SYNTHETIC_AUDIT_UNAVAILABLE'); } } });
    const started = await stage(f, issued, key, failing); const proof = input(started, key, 'get');
    await assert.rejects(started.service.complete(proof), /SYNTHETIC_AUDIT_UNAVAILABLE/);
    assert.equal(await f.count(), 0);
    const row = (await pool.query(`SELECT t.possession_attempts,t.consumed_at,g.consumed_at AS grant_consumed,o.security_version
      FROM platform_passkey_enrollment_transactions t JOIN platform_passkey_enrollment_grants g ON g.id=t.grant_id
      JOIN platform_operators o ON o.id=g.operator_id WHERE g.id=$1`, [issued.grant.grantId])).rows[0];
    assert.equal(row.possession_attempts, 0); assert.equal(row.consumed_at, null); assert.equal(row.grant_consumed, null);
    assert.equal(Number(row.security_version), 1);
    assert.equal((await f.service().complete(proof)).status, 'credential_enrolled');
  });

  await t.test('independent recovery permanently revokes old keys and supersedes all previous version authority', async () => {
    const f = await setup(); const firstKey = platformPasskeyFixture({ operatorId: f.operatorId });
    const first = await issuer.issueOffline(f.request); const original = await stage(f, first, firstKey);
    await original.service.complete(input(original, firstKey, 'get', { counter: 0 }));
    const recovery = await issuer.issueOffline({ ...f.request, kind: 'recovery', operatorSecurityVersion: 2 });
    assert.equal(recovery.operatorSecurityVersion, 4, 'key revocation and final recovery grant each fence prior authority');
    const revoked = await pool.query('SELECT revoked_at FROM platform_passkey_credentials WHERE operator_id=$1', [f.operatorId]);
    assert.ok(revoked.rows[0].revoked_at);
    const replacement = platformPasskeyFixture({ operatorId: f.operatorId });
    const next = await stage(f, recovery, replacement);
    assert.equal(next.userHandle, original.userHandle, 'the operator handle remains stable across recovery');
    await next.service.complete(input(next, replacement, 'get', { counter: 0 }));
    assert.equal(await f.count(), 2);
    await assert.rejects(pool.query(`UPDATE platform_passkey_credentials SET revoked_at=NULL
      WHERE operator_id=$1 AND revoked_at IS NOT NULL`,
      [f.operatorId]), /IMMUTABLE/);
    assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
    assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
    assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before the retained populated056 guard.
    await assert.rejects(rollbackLatest(pool), /PLATFORM_PASSKEY_ENROLLMENT_REQUIRES_VERIFIED_RECOVERY/);
    await migrateUp(pool); // Restore Customer057 before subsequent passkey cases.
  });

  await t.test('an exact real step-up adds a second key; revocation logs out and the last key remains protected', async () => {
    const f = await setup(); const firstKey = platformPasskeyFixture({ operatorId: f.operatorId });
    const bootstrap = await issuer.issueOffline(f.request); const initial = await stage(f, bootstrap, firstKey);
    await initial.service.complete(input(initial, firstKey, 'get'));
    const sessions = createPlatformSessionService({ repository: createPostgresPlatformSessionRepository(pool, { auditRepository }),
      publicOrigin: 'https://ops-int.example.com', csrfSecret: 'c'.repeat(48), securityEpoch: 8 });
    const authService = createPlatformPasskeyAuthService({
      repository: createPostgresPlatformPasskeyAuthRepository(pool, { verifier, auditRepository }),
      primaryOperatorService: f.primaryOperatorService, verifier, sessionService: sessions,
      environment: 'int', securityEpoch: 8, transactionSecret: 't'.repeat(48) });
    const lifecycle = createPlatformPasskeyLifecycleService({ authService, sessionService: sessions, repository,
      environment: 'int', securityEpoch: 8 });
    function signed(started, key, counter) {
      const response = key.response('get', { counter, client: { challenge: started.options.challenge } });
      response.response.userHandle = initial.userHandle;
      return { state: started.state, response,
        cookie: readPlatformPasskeyTransactionCookie({ cookie: started.setCookie.split(';')[0] }) };
    }
    async function login(key, counter) {
      const started = await authService.startLogin('verified-primary-port-fixture');
      return authService.complete(signed(started, key, counter));
    }
    const loggedIn = await login(firstKey, 2);
    await assert.rejects(repository.issueAdditional({ principal: loggedIn.principal, environment: 'int', securityEpoch: 8,
      correlationId: randomUUID() }), /ENROLLMENT_RECORD_INVALID/);
    const addition = await lifecycle.startAddition(loggedIn.principal);
    const additional = await lifecycle.issueAdditional({ ...signed(addition, firstKey, 3),
      request: { headers: { cookie: loggedIn.setCookies[0].split(';')[0] } } });
    assert.equal(additional.status, 'operation_completed');
    assert.equal(additional.principal.assurance.level, 'mfa');
    const secondKey = platformPasskeyFixture({ operatorId: f.operatorId });
    const next = await stage(f, additional.result, secondKey);
    assert.equal(next.userHandle, initial.userHandle);
    await next.service.complete(input(next, secondKey, 'get'));
    assert.equal(await f.count(), 2);
    const session = await login(secondKey, 2);
    const revocation = await lifecycle.startRevocation(session.principal, firstKey.credential.id);
    const revoked = await lifecycle.revoke({ ...signed(revocation, secondKey, 3), credentialId: firstKey.credential.id,
      request: { headers: { cookie: session.setCookies[0].split(';')[0] } } });
    assert.equal(revoked.status, 'reauthentication_required');
    assert.equal(Object.hasOwn(revoked, 'principal'), false);
    assert.match(revoked.setCookies[0], /Max-Age=0/);
    assert.equal(await sessions.resolvePrincipal({ headers: { cookie: session.setCookies[0].split(';')[0] } }), null);
    const remaining = await login(secondKey, 4);
    // Five ceremonies in the same DB-clock window are deliberately the limit,
    // including consumed proofs. Verify the cap before moving fixture time.
    await assert.rejects(lifecycle.startRevocation(remaining.principal, secondKey.credential.id), /AUTHENTICATION_REJECTED/);
    await pool.query(`UPDATE platform_passkey_auth_transactions
      SET created_at=created_at-INTERVAL '3 minutes',expires_at=expires_at-INTERVAL '3 minutes',
        consumed_at=consumed_at-INTERVAL '3 minutes' WHERE operator_id=$1`, [f.operatorId]);
    const last = await lifecycle.startRevocation(remaining.principal, secondKey.credential.id);
    await assert.rejects(lifecycle.revoke({ ...signed(last, secondKey, 5), credentialId: secondKey.credential.id,
      request: { headers: { cookie: remaining.setCookies[0].split(';')[0] } } }), /LIFECYCLE_REJECTED/);
    const key = (await pool.query('SELECT revoked_at,signature_counter FROM platform_passkey_credentials WHERE credential_id=$1',
      [secondKey.credential.id])).rows[0];
    assert.equal(key.revoked_at, null); assert.equal(Number(key.signature_counter), 4);
    assert.ok(await sessions.resolvePrincipal({ headers: { cookie: remaining.setCookies[0].split(';')[0] } }));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM platform_sessions
      WHERE operator_id=$1 AND assurance_level='step_up' AND revoked_at IS NULL`, [f.operatorId])).rows[0].n, 0);
  });

  await t.test('durable primary bootstrap and a second key finish setup without exposing a business or strong session', async () => {
    const f = await setup();
    const sessions = createPlatformSessionService({ repository: createPostgresPlatformSessionRepository(pool, { auditRepository }),
      publicOrigin: 'https://ops-int.example.com', csrfSecret: 'c'.repeat(48), securityEpoch: 8 });
    const authRepository = createPostgresPlatformPasskeyAuthRepository(pool, { verifier, auditRepository });
    const authService = createPlatformPasskeyAuthService({ repository: authRepository, primaryOperatorService: f.primaryOperatorService,
      verifier, sessionService: sessions, environment: 'int', securityEpoch: 8, transactionSecret: 't'.repeat(48),
      allowBusinessLogin: false, minimumCredentialCount: 2 });
    const flow = createPlatformPasskeyEnrollmentFlow({ authService, repository, verifier, environment: 'int', securityEpoch: 8 });
    const cookie = started => readPlatformPasskeyTransactionCookie({ cookie: started.setCookie.split(';')[0] });
    const sessionsCount = async () => (await pool.query(`SELECT count(*)::int AS n FROM platform_sessions
      WHERE operator_id=$1 AND revoked_at IS NULL`, [f.operatorId])).rows[0].n;
    const issued = await issuer.issueOffline(f.request);
    const primary = await authService.startLogin('verified-primary-port-fixture');
    assert.equal(primary.status, 'enrollment_required');
    assert.equal(Object.hasOwn(primary, 'options'), false);
    const primaryInput = { cookie: cookie(primary), state: primary.state };
    await assert.rejects(authService.complete({ ...primaryInput, response: {} }), /AUTHENTICATION_REJECTED/);
    await assert.rejects(flow.start({ ...primaryInput, grant: { ...issued.grant, token: verifier.createChallenge() } }),
      /ENROLLMENT_REJECTED/);
    // Failed grant matching rolls back pending-primary consumption atomically.
    assert.equal((await authService.pendingAuthentication(primaryInput.cookie)).status, 'enrollment_required');
    const first = await flow.start({ ...primaryInput, grant: issued.grant });
    await assert.rejects(flow.start({ ...primaryInput, grant: issued.grant }), /AUTHENTICATION_REJECTED/);
    const firstKey = platformPasskeyFixture({ operatorId: f.operatorId });
    async function enroll(started, key) {
      const startedCookie = readPlatformPasskeyEnrollmentCookie({ cookie: started.setCookie.split(';')[0] });
      const resumed = await flow.pending(startedCookie);
      assert.equal(resumed.status, 'registration_required');
      assert.deepEqual(resumed.options, started.options);
      const registration = key.response('create', { client: { challenge: started.options.challenge } });
      const staged = await flow.register({ cookie: startedCookie, state: started.state, response: registration });
      assert.equal((await flow.pending(startedCookie)).status, 'possession_required');
      const response = key.response('get', { counter: 1, client: { challenge: staged.options.challenge } });
      response.response.userHandle = started.options.user.id;
      assert.equal((await flow.complete({ cookie: startedCookie, state: started.state, response })).status, 'credential_enrolled');
      return started.options.user.id;
    }
    const handle = await enroll(first, firstKey);
    assert.equal(await f.count(), 1); assert.equal(await sessionsCount(), 0);
    const secondPrimary = await authService.startLogin('verified-primary-port-fixture');
    const proof = firstKey.response('get', { counter: 2, client: { challenge: secondPrimary.options.challenge } });
    proof.response.userHandle = handle;
    const secondInput = { cookie: cookie(secondPrimary), state: secondPrimary.state, response: proof };
    await assert.rejects(authService.complete(secondInput), /SETUP_REQUIRED/);
    assert.equal(await sessionsCount(), 0);
    const second = await flow.continueSetup(secondInput);
    assert.equal(second.status, 'registration_required');
    assert.equal(Object.hasOwn(second, 'principal'), false);
    assert.doesNotMatch(second.setCookie, /cm_platform_session/);
    assert.equal(await sessionsCount(), 0, 'temporary strong session was revoked inside the setup transaction');
    const secondKey = platformPasskeyFixture({ operatorId: f.operatorId });
    assert.equal(await enroll(second, secondKey), handle);
    assert.equal(await f.count(), 2);
    const finished = await authService.startLogin('verified-primary-port-fixture');
    const finishedProof = secondKey.response('get', { counter: 2, client: { challenge: finished.options.challenge } });
    finishedProof.response.userHandle = handle;
    assert.equal((await flow.continueSetup({ cookie: cookie(finished), state: finished.state,
      response: finishedProof })).status, 'setup_complete');
    assert.equal(await sessionsCount(), 0);
    const active = createPlatformPasskeyAuthService({ repository: authRepository, primaryOperatorService: f.primaryOperatorService,
      verifier, sessionService: sessions, environment: 'int', securityEpoch: 8, transactionSecret: 't'.repeat(48),
      allowBusinessLogin: true, minimumCredentialCount: 2 });
    const login = await active.startLogin('verified-primary-port-fixture');
    const loginProof = secondKey.response('get', { counter: 3, client: { challenge: login.options.challenge } });
    loginProof.response.userHandle = handle;
    const authenticated = await active.complete({ cookie: cookie(login), state: login.state, response: loginProof });
    assert.equal(authenticated.status, 'authenticated');
    assert.equal(authenticated.principal.assurance.level, 'mfa'); assert.equal(await sessionsCount(), 1);
  });

});
