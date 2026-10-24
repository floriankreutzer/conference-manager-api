import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Readable } from 'node:stream';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { protectPlatformPasskeyRoute } from '../src/platform/http/passkey-operation-route.js';
import { platformTenantRoutes } from '../src/platform/http/tenant-routes.js';
import { createPlatformPrincipalGuard } from '../src/platform/http/principal-guard.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { readPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresEntitlementRepository } from '../src/persistence/postgres/entitlement-repository.js';
import { createPostgresPlatformEntitlementOperationsRepository } from '../src/persistence/postgres/platform-operations-repository.js';

const roles = ['platform_security_admin'];
const hash = () => randomBytes(32).toString('hex');

test('durable Platform passkey authentication is bounded, single-use, audited and atomic with session issuance', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true);
  await migrateUp(pool);
  const verifier = createPlatformPasskeyVerifier({ publicOrigin: 'https://ops-int.example.com', environment: 'int' });
  const auditRepository = createPostgresPlatformAuditRepository(pool, { hmacSecret: 'a'.repeat(48) });
  const repository = createPostgresPlatformPasskeyAuthRepository(pool, { verifier, auditRepository });
  const sessions = createPlatformSessionService({
    repository: createPostgresPlatformSessionRepository(pool, { auditRepository }),
    publicOrigin: 'https://ops-int.example.com', csrfSecret: 'c'.repeat(48), securityEpoch: 7,
  });

  async function setup() {
    const operatorId = randomUUID();
    const fixture = platformPasskeyFixture({ operatorId });
    await pool.query(`INSERT INTO platform_operators
      (id,provider,provider_tenant_reference,provider_subject_reference,status,scope_mode,roles)
      VALUES ($1,'microsoft_entra_platform','directory',$2,'active','all',$3)`, [operatorId, operatorId, roles]);
    const credentialRecordId = randomUUID();
    await pool.query(`INSERT INTO platform_passkey_credentials
      (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
      VALUES ($1,$2,'int',$3,$4,$5,0,false,false)`,
    [credentialRecordId, operatorId, fixture.credential.id, fixture.credential.publicKey, fixture.userHandle]);
    const version = Number((await pool.query('SELECT security_version FROM platform_operators WHERE id = $1',
      [operatorId])).rows[0].security_version);
    assert.equal(version, 2);
    const record = { id: randomUUID(), stateHash: hash(), browserHash: hash(), challenge: fixture.challenge,
      operatorId, operatorSecurityVersion: version, environment: 'int', securityEpoch: 7,
      purpose: 'login', expectedSessionId: null, operationHash: null, correlationId: randomUUID(), ttlSeconds: 120 };
    const request = (changes = {}, response = fixture.response('get')) => ({
      stateHash: record.stateHash, browserHash: record.browserHash, operatorId,
      operatorSecurityVersion: version, environment: 'int', securityEpoch: 7,
      purpose: 'login', expectedSessionId: null, operationHash: null, response, ...changes,
    });
    const state = async () => (await pool.query(`SELECT attempts,consumed_at,signature_counter FROM
      platform_passkey_auth_transactions a JOIN platform_passkey_credentials c ON c.operator_id = a.operator_id
      WHERE a.id = $1`, [record.id])).rows[0];
    return { operatorId, fixture, credentialRecordId, record, request, state };
  }

  function identity(operatorId, context, level = 'mfa') {
    return { operatorId,
      providerIdentity: { provider: 'microsoft_entra_platform', tenantReference: 'directory', subjectReference: operatorId },
      roles, permissions: permissionsForPlatformRoles(roles), securityVersion: context.securityVersion,
      targetScope: { mode: 'all', securityVersion: context.securityVersion },
      assurance: { level, authenticationContext: 'application-passkey', authenticatedAt: context.authenticatedAt } };
  }

  await t.test('real signed assertion issues an actual session and concurrent replay succeeds only once', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    let calls = 0;
    const issue = async (context) => {
      calls += 1;
      return sessions.issue(identity(f.operatorId, context),
      { correlationId: context.correlationId });
    };
    const outcomes = await Promise.all([repository.authenticate(f.request(), issue), repository.authenticate(f.request(), issue)]);
    assert.equal(calls, 1);
    assert.equal(outcomes.filter(Boolean).length, 1);
    const session = outcomes.find(Boolean);
    assert.equal((await sessions.resolvePrincipal({ headers: { cookie: session.setCookie.split(';')[0] } })).operatorId,
      f.operatorId);
    assert.equal(Number((await f.state()).signature_counter), 1);
    assert.equal((await f.state()).attempts, 1);
    assert.ok((await f.state()).consumed_at);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM platform_audit_events WHERE target_id = $1",
      [f.record.id])).rows[0].count, 1);
  });

  await t.test('application login composes pending Microsoft identity, durable options, real signature and actual session', async () => {
    const f = await setup();
    const primaryOperatorService = { async resolve(assertion) {
      assert.equal(assertion, 'synthetic-verified-primary');
      return { operatorId: f.operatorId, securityVersion: 2, primaryAuthenticatedAt: new Date().toISOString() };
    } };
    const service = createPlatformPasskeyAuthService({ repository, primaryOperatorService, verifier, sessionService: sessions,
      environment: 'int', securityEpoch: 7, transactionSecret: 'p'.repeat(48), minimumCredentialCount: 1 });
    const started = await service.startLogin('synthetic-verified-primary');
    assert.equal(started.status, 'passkey_required');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_sessions WHERE operator_id = $1',
      [f.operatorId])).rows[0].n, 0);
    const cookie = readPlatformPasskeyTransactionCookie({ cookie: started.setCookie.split(';')[0] });
    const options = await service.authenticationOptions(cookie);
    assert.equal(options.options.challenge, started.options.challenge);
    const response = f.fixture.response('get', { client: { challenge: options.options.challenge } });
    const completed = await service.complete({ cookie, state: options.state, response });
    assert.equal(completed.status, 'authenticated');
    assert.equal(completed.principal.operatorId, f.operatorId);
    assert.equal(completed.principal.assurance.authenticationContext, 'cm:pk:v1');
    assert.equal(completed.setCookies.length, 2);
    await assert.rejects(service.complete({ cookie, state: options.state, response }), /AUTHENTICATION_REJECTED/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_sessions WHERE operator_id = $1',
      [f.operatorId])).rows[0].n, 1);
    await pool.query('CREATE TABLE passkey_test_mutations (id uuid PRIMARY KEY)');
    const operationHash = hash();
    const step = await service.startStepUp(completed.principal, { operationHash });
    const stepCookie = readPlatformPasskeyTransactionCookie({ cookie: step.setCookie.split(';')[0] });
    const stepResponse = f.fixture.response('get', { counter: 2, client: { challenge: step.options.challenge } });
    const input = { cookie: stepCookie, state: step.state, response: stepResponse, operationHash,
      request: { headers: { cookie: completed.setCookies[0].split(';')[0] } } };
    const mutationId = randomUUID();
    const tenantId = randomUUID();
    await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Signed entitlement fixture','active')", [tenantId]);
    const tenantAuditRepository = createPostgresAuditRepository(pool, { hmacSecret: 't'.repeat(48) });
    const entitlementRepository = createPostgresEntitlementRepository(pool, { auditRepository: tenantAuditRepository });
    const { entitlementReader } = createPostgresPlatformEntitlementOperationsRepository(pool, {
      tenantAuditRepository, platformAuditRepository: auditRepository, entitlementRepository, cursorSecret: 'u'.repeat(48),
    });
    await assert.rejects(service.executeStepUp(input, () => withPostgresTransaction(pool, async client => {
      assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation, 'repeatable read');
      assert.equal((await entitlementReader.findTenantState(tenantId)).tenantId, tenantId);
      await client.query('INSERT INTO passkey_test_mutations VALUES ($1)', [mutationId]);
      throw new Error('EXPECTED_BUSINESS_MUTATION_FAILURE');
    })), /EXPECTED_BUSINESS_MUTATION_FAILURE/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM passkey_test_mutations')).rows[0].n, 0);
    assert.equal((await sessions.resolvePrincipal(input.request)).operatorId, f.operatorId);
    const executed = await service.executeStepUp(input, context => withPostgresTransaction(pool, async client => {
      assert.equal(context.principal.assurance.level, 'step_up');
      assert.equal(context.operationHash, operationHash);
      assert.equal((await entitlementReader.findTenantState(tenantId)).tenantId, tenantId);
      await client.query('INSERT INTO passkey_test_mutations VALUES ($1)', [mutationId]);
      return { changed: true };
    }));
    assert.equal(executed.status, 'operation_completed');
    assert.equal(executed.principal.assurance.level, 'mfa');
    assert.equal(await sessions.resolvePrincipal(input.request), null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM platform_sessions WHERE operator_id=$1
      AND revoked_at IS NULL AND assurance_level='step_up'`, [f.operatorId])).rows[0].n, 0);
    await assert.rejects(service.executeStepUp(input, () => true), /AUTHENTICATION_REJECTED/);
    assert.deepEqual(await repository.listActiveCredentialIds({ operatorId: randomUUID(),
      operatorSecurityVersion: 2, environment: 'int' }), []);
    assert.deepEqual(await repository.listActiveCredentialIds({ operatorId: f.operatorId,
      operatorSecurityVersion: 2, environment: 'prod' }), []);
  });

  await t.test('concrete route commits a real signature, SQL mutation, buffered response and ordinary session together', async () => {
    const f = await setup(); const secondKey = platformPasskeyFixture({ operatorId: f.operatorId });
    await pool.query(`UPDATE platform_operators SET roles=ARRAY['platform_security_admin','platform_tenant_operator'] WHERE id=$1`,
      [f.operatorId]);
    await pool.query(`INSERT INTO platform_passkey_credentials
      (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
      VALUES ($1,$2,'int',$3,$4,$5,0,false,false)`,
    [randomUUID(), f.operatorId, secondKey.credential.id, secondKey.credential.publicKey, f.fixture.userHandle]);
    const version = Number((await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',
      [f.operatorId])).rows[0].security_version);
    const service = createPlatformPasskeyAuthService({ repository, verifier, sessionService: sessions,
      primaryOperatorService: { async resolve() { return { operatorId: f.operatorId, securityVersion: version,
        primaryAuthenticatedAt: new Date().toISOString() }; } }, environment: 'int', securityEpoch: 7,
      transactionSecret: 'p'.repeat(48), minimumCredentialCount: 2 });
    const started = await service.startLogin('synthetic-verified-primary');
    const loginResponse = f.fixture.response('get', { client: { challenge: started.options.challenge } });
    const login = await service.complete({ cookie: readPlatformPasskeyTransactionCookie({ cookie: started.setCookie.split(';')[0] }),
      state: started.state, response: loginResponse });
    const authorizationPolicy = createPlatformAuthorizationPolicy();
    const auditService = createPlatformAuditService({ repository: auditRepository, authorizationPolicy,
      tenantTargetPolicy: { async queryScope() { throw new Error('UNEXPECTED_AUDIT_READ'); } } });
    const guard = createPlatformPrincipalGuard({ platformSessionService: sessions, platformAuditService: auditService });
    let failMutation = true;
    const mutationId = randomUUID();
    const operationBody = { displayName: 'Signed synthetic customer', reason: 'Synthetic signed onboarding',
      confirmation: { action: 'tenant.invitation.create', displayName: 'Signed synthetic customer' } };
    const handler = protectPlatformPasskeyRoute(platformTenantRoutes,
      { authService: service, environment: 'int', securityEpoch: 7 }).createHandler({ maxBodyBytes: 32768, maxResponseBytes: 65536,
      platformPrincipalGuard: guard, platformAuditService: auditService,
      platformTenantOperationsService: { async listDirectory() {}, async revokeInvitation() {}, async reissueInvitation() {},
        async transitionLifecycle() {}, async createTenantInvitation(value) {
          authorizationPolicy.authorize(value.operatorContext, 'platform:invitation:manage');
          await withPostgresTransaction(pool, async client => {
            await client.query('INSERT INTO passkey_test_mutations VALUES ($1)', [mutationId]);
            if (failMutation) throw new Error('EXPECTED_CONCRETE_BUSINESS_FAILURE');
          });
          return { outcome: 'updated' };
        } },
    });
    async function invoke({ proof, pendingCookie, body = operationBody } = {}) {
      const encoded = JSON.stringify(body); const request = Readable.from([Buffer.from(encoded)]);
      request.method = 'POST'; request.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(encoded)),
        'x-csrf-token': login.csrfToken, 'idempotency-key': mutationId,
        cookie: [login.setCookies[0].split(';')[0],pendingCookie?.split(';')[0]].filter(Boolean).join('; '),
        ...(proof ? { 'x-platform-passkey-proof': Buffer.from(JSON.stringify(proof)).toString('base64url') } : {}) };
      const out = { statusCode: 200, headers: {}, body: null, setHeader(name, value) { this.headers[name] = value; },
        end(value) { this.body = JSON.parse(value); } };
      try { await handler({ path: '/api/v1/platform/tenants', parsedUrl: new URL('https://ops-int.example.com/api/v1/platform/tenants'),
        request, response: out, requestId: randomUUID() }); }
      catch (error) { out.error = error; }
      return out;
    }
    const challenge = await invoke(); assert.equal(challenge.statusCode, 428);
    const response = f.fixture.response('get', { counter: 2, client: { challenge: challenge.body.options.challenge } });
    const proof = { state: challenge.body.state, response }; const pendingCookie = challenge.headers['Set-Cookie'];
    assert.match(pendingCookie, /^cm_platform_operation_tx=/);
    const swapped = await invoke({ proof, pendingCookie, body: { ...operationBody, reason: 'Different signed operation' } });
    assert.equal(swapped.error.statusCode, 403); assert.equal(swapped.body, null);
    const failed = await invoke({ proof, pendingCookie }); assert.match(failed.error.message, /EXPECTED_CONCRETE_BUSINESS_FAILURE/);
    assert.equal(failed.body, null); assert.equal(failed.headers['Set-Cookie'], undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM passkey_test_mutations WHERE id=$1', [mutationId])).rows[0].n, 0);
    assert.equal(Number((await pool.query('SELECT signature_counter FROM platform_passkey_credentials WHERE id=$1',
      [f.credentialRecordId])).rows[0].signature_counter), 1);
    assert.ok(await sessions.resolvePrincipal({ headers: { cookie: login.setCookies[0].split(';')[0] } }));
    failMutation = false;
    const completed = await invoke({ proof, pendingCookie }); assert.equal(completed.error, undefined);
    assert.equal(completed.statusCode, 201); assert.deepEqual(completed.body, { outcome: 'updated' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM passkey_test_mutations WHERE id=$1', [mutationId])).rows[0].n, 1);
    const current = await sessions.resolvePrincipal({ headers: { cookie: completed.headers['Set-Cookie'][0].split(';')[0] } });
    assert.equal(current.assurance.level, 'mfa'); assert.notEqual(current.session.id, login.principal.session.id);
    assert.equal((await invoke({ proof, pendingCookie })).body, null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM platform_sessions
      WHERE operator_id=$1 AND assurance_level='step_up' AND revoked_at IS NULL`, [f.operatorId])).rows[0].n, 0);
  });

  await t.test('wrong browser, owner, epoch, environment, purpose and security version do not consume a legitimate attempt', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    for (const change of [{ browserHash: hash() }, { operatorId: randomUUID() }, { securityEpoch: 8 },
      { environment: 'prod' }, { operatorSecurityVersion: 1 },
      { purpose: 'step_up', expectedSessionId: randomUUID(), operationHash: hash() }]) {
      assert.equal(await repository.authenticate(f.request(change), () => { throw new Error('MUST_NOT_ISSUE'); }), null);
    }
    assert.equal((await f.state()).attempts, 0);
    await pool.query("UPDATE platform_operators SET status = 'disabled' WHERE id = $1", [f.operatorId]);
    assert.equal(await repository.authenticate(f.request(), () => true), null);
  });

  await t.test('five failed signatures exhaust the ceremony; completed and exhausted ceremonies retain creation limits', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    for (let i = 0; i < 7; i += 1) {
      assert.equal(await repository.authenticate(f.request({}, f.fixture.response('get', { client: { challenge: hash() } })),
        () => { throw new Error('MUST_NOT_ISSUE'); }), null);
    }
    assert.equal((await f.state()).attempts, 5);
    assert.equal((await f.state()).consumed_at, null);
    assert.equal(await repository.authenticate(f.request(), () => true), null);
    for (let i = 0; i < 4; i += 1) {
      assert.equal(await repository.create({ ...f.record, id: randomUUID(), stateHash: hash() }), true);
    }
    assert.equal(await repository.create({ ...f.record, id: randomUUID(), stateHash: hash() }), false);
  });

  await t.test('audit and session failure roll back consumption, attempts and counter, allowing a safe retry', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    const failing = createPostgresPlatformPasskeyAuthRepository(pool, { verifier,
      auditRepository: { async appendWithClient() { throw new Error('EXPECTED_AUDIT_FAILURE'); } } });
    await assert.rejects(failing.authenticate(f.request(), () => true), /EXPECTED_AUDIT_FAILURE/);
    assert.equal((await f.state()).attempts, 0);
    await assert.rejects(repository.authenticate(f.request(), async () => { throw new Error('EXPECTED_SESSION_FAILURE'); }),
      /EXPECTED_SESSION_FAILURE/);
    assert.equal((await f.state()).consumed_at, null);
    assert.equal(Number((await f.state()).signature_counter), 0);
    assert.equal(await repository.authenticate(f.request(), () => 'issued'), 'issued');
  });

  await t.test('two ceremonies cannot advance the same nonzero counter twice and zero-counter keys remain one-use', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    const second = { ...f.record, id: randomUUID(), stateHash: hash(), challenge: verifier.createChallenge() };
    assert.equal(await repository.create(second), true);
    const response = f.fixture.response('get', { client: { challenge: second.challenge } });
    const results = await Promise.all([repository.authenticate(f.request(), () => true),
      repository.authenticate(f.request({ stateHash: second.stateHash }, response), () => true)]);
    assert.equal(results.filter(Boolean).length, 1);
    const zero = await setup();
    assert.equal(await repository.create(zero.record), true);
    const zeroRequest = zero.request({}, zero.fixture.response('get', { counter: 0 }));
    assert.equal(await repository.authenticate(zeroRequest, () => true), true);
    assert.equal(await repository.authenticate(zeroRequest, () => true), null);
  });

  await t.test('step-up binds the exact operation and live session and rotates it atomically', async () => {
    const f = await setup();
    const initial = await sessions.issue(identity(f.operatorId,
      { securityVersion: 2, authenticatedAt: new Date().toISOString() }));
    const operationHash = hash();
    const record = { ...f.record, purpose: 'step_up', expectedSessionId: initial.principal.session.id, operationHash };
    const request = f.request({ purpose: 'step_up', expectedSessionId: initial.principal.session.id, operationHash });
    assert.equal(await repository.create(record), true);
    assert.equal(await repository.authenticate({ ...request, operationHash: hash() }, () => true), null);
    assert.equal((await f.state()).attempts, 0);
    const rotated = await repository.authenticate(request, (context) => sessions.rotate(initial.principal,
      identity(f.operatorId, context, 'step_up'), { purpose: 'step_up', correlationId: context.correlationId }));
    assert.equal(rotated.principal.assurance.level, 'step_up');
    assert.notEqual(rotated.principal.session.id, initial.principal.session.id);
    assert.equal(await sessions.resolvePrincipal({ headers: { cookie: initial.setCookie.split(';')[0] } }), null);
    const stale = { ...record, id: randomUUID(), stateHash: hash() };
    assert.equal(await repository.create(stale), false);
  });

  await t.test('credential capacity and database constraints preserve ownership and monotonic counters', async () => {
    const f = await setup();
    for (const [credentialId, publicKey] of [
      ['', f.fixture.credential.publicKey], ['invalid=encoding', f.fixture.credential.publicKey],
      ['a'.repeat(1367), f.fixture.credential.publicKey], [hash(), ''],
      [hash(), 'invalid=encoding'], [hash(), 'a'.repeat(513)],
    ]) {
      await assert.rejects(pool.query(`INSERT INTO platform_passkey_credentials
        (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
        VALUES ($1,$2,'int',$3,$4,$5,0,false,false)`,
      [randomUUID(), f.operatorId, credentialId, publicKey, f.fixture.userHandle]),
      error => ['23514', '22001'].includes(error.code));
    }
    for (let i = 0; i < 4; i += 1) {
      const key = platformPasskeyFixture({ operatorId: f.operatorId });
      await pool.query(`INSERT INTO platform_passkey_credentials
        (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
        VALUES ($1,$2,'int',$3,$4,$5,0,false,false)`,
      [randomUUID(), f.operatorId, key.credential.id, key.credential.publicKey, key.userHandle]);
    }
    await assert.rejects(pool.query(`INSERT INTO platform_passkey_credentials
      (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
      VALUES ($1,$2,'int',$3,$4,$5,0,false,false)`,
    [randomUUID(), f.operatorId, hash(), f.fixture.credential.publicKey, f.fixture.userHandle]), /CAPACITY/);
    await pool.query('UPDATE platform_passkey_credentials SET signature_counter = 3 WHERE id = $1', [f.credentialRecordId]);
    await assert.rejects(pool.query('UPDATE platform_passkey_credentials SET signature_counter = 2 WHERE id = $1',
      [f.credentialRecordId]), /IMMUTABLE/);
    await assert.rejects(pool.query('DELETE FROM platform_passkey_credentials WHERE id = $1',
      [f.credentialRecordId]), /HISTORY_IMMUTABLE/);
    // New credentials revoke the authority snapshot used to construct this ceremony.
    assert.equal(await repository.create(f.record), false);
  });

  await t.test('database-clock expiry, revoked key and stale operator version fail closed', async () => {
    const f = await setup();
    assert.equal(await repository.create(f.record), true);
    await pool.query(`UPDATE platform_passkey_auth_transactions SET created_at = clock_timestamp() - INTERVAL '3 minutes',
      expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1`, [f.record.id]);
    assert.equal(await repository.authenticate(f.request(), () => true), null);
    const other = await setup();
    assert.equal(await repository.create(other.record), true);
    await pool.query('UPDATE platform_passkey_credentials SET revoked_at = clock_timestamp() WHERE id = $1',
      [other.credentialRecordId]);
    assert.equal(await repository.authenticate(other.request(), () => true), null);
    assert.equal(Number((await pool.query('SELECT security_version FROM platform_operators WHERE id = $1',
      [other.operatorId])).rows[0].security_version), 3);
    await assert.rejects(pool.query('UPDATE platform_passkey_credentials SET revoked_at = NULL WHERE id = $1',
      [other.credentialRecordId]), /IMMUTABLE/);
    await assert.rejects(pool.query('UPDATE platform_passkey_credentials SET operator_id = $1 WHERE id = $2',
      [f.operatorId, other.credentialRecordId]), /IMMUTABLE/);
    assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
    assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
    assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
    assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
    assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
    assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
    assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
    assert.equal(await rollbackLatest(pool), true); // Empty054 before the retained053 populated guard.
    await assert.rejects(rollbackLatest(pool), /PLATFORM_PASSKEY_STORAGE_REQUIRES_VERIFIED_RECOVERY/);
    await migrateUp(pool); // Restore current055 readiness without changing retained Platform credentials.
    assert.equal(await isPostgresSchemaReady(pool), true);
  });
});
