import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';

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
    await assert.rejects(rollbackLatest(pool), /PLATFORM_PASSKEY_STORAGE_REQUIRES_VERIFIED_RECOVERY/);
    assert.equal(await isPostgresSchemaReady(pool), true);
  });
});
