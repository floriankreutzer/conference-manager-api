import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformPasskeyAuthRepository } from '../src/persistence/postgres/platform-passkey-auth-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createProtectedPlatformSessions } from '../src/platform/identity/protected-platform-sessions.js';
import { createPlatformPasskeyAuthService } from '../src/platform/identity/passkey-auth-service.js';
import { createPlatformPasskeyVerifier } from '../src/platform/identity/passkey-verifier.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { readPlatformPasskeyTransactionCookie } from '../src/platform/identity/passkey-auth-cookie.js';
import { platformPasskeyFixture } from '../tests/support/platform-passkey-fixture.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

test('native signed continuation uses the protected max1 RR scope and rolls proof, future session and mutation back together',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const operatorId=randomUUID(),epoch=randomUUID(),roles=['platform_security_admin'];
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
    VALUES($1::uuid,$2,'directory',$1::text,'all',$3)`,[operatorId,PLATFORM_ENTRA_PROVIDER,roles]);
  const keys=[platformPasskeyFixture({ operatorId }),platformPasskeyFixture({ operatorId })];
  for (const key of keys) await pool.query(`INSERT INTO platform_passkey_credentials
    (id,operator_id,environment,credential_id,public_key,user_handle,signature_counter,backup_eligible,backed_up)
    VALUES($1,$2,'int',$3,$4,$5,0,false,false)`,
  [randomUUID(),operatorId,key.credential.id,key.credential.publicKey,key.userHandle]);
  const version=Number((await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',
    [operatorId])).rows[0].security_version);
  assert.equal(version,3);
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await pool.query('CREATE TABLE synthetic_continuation_probe(id uuid PRIMARY KEY,source_session uuid REFERENCES platform_sessions(id))');
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const auditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const sessionOptions={ repository: createPostgresPlatformSessionRepository(pool,{ auditRepository }),
    publicOrigin: 'https://ops-int.example.com',csrfSecret: 'c'.repeat(48),securityEpoch: 7 };
  const sessions=createProtectedPlatformSessions({ ...sessionOptions,environment: 'int',protectedSecurityEpoch: epoch });
  const verifier=createPlatformPasskeyVerifier({ publicOrigin: 'https://ops-int.example.com',environment: 'int' });
  const repository=createPostgresPlatformPasskeyAuthRepository(pool,{ verifier,auditRepository,
    stepUpTransaction: scopes.withSyntheticExclusive });
  const service=createPlatformPasskeyAuthService({ repository,verifier,sessionService: sessions,
    primaryOperatorService: { resolve() { throw new Error('PRIMARY_NOT_USED_BY_THIS_FIXTURE'); } },
    environment: 'int',securityEpoch: 7,transactionSecret: 'p'.repeat(48),minimumCredentialCount: 2 });
  const initial=await sessions.issue({ operatorId,securityVersion: version,roles,permissions: permissionsForPlatformRoles(roles),
    providerIdentity: { provider: PLATFORM_ENTRA_PROVIDER,tenantReference: 'directory',subjectReference: operatorId },
    targetScope: { mode: 'all',securityVersion: version },
    assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: new Date().toISOString() } });
  const operationHash='d'.repeat(64);
  const step=await scopes.withShared(()=>service.startStepUp(initial.principal,{ operationHash }));
  const input={ cookie: readPlatformPasskeyTransactionCookie({ cookie: step.setCookie.split(';')[0] }),state: step.state,
    operationHash,response: keys[0].response('get',{ client: { challenge: step.options.challenge } }),
    request: { headers: { cookie: initial.setCookie.split(';')[0] } } };
  let temporaryId,normalId;
  const completed=await service.executeStepUpWithContinuation(input,async context=>{
    const authority=service.verifiedOperationWithContinuation(context,operationHash);
    temporaryId=authority.principal.session.id;normalId=authority.continuationPrincipal.session.id;
    assert.notEqual(normalId,temporaryId);assert.notEqual(normalId,initial.principal.session.id);
    await withPostgresTransaction(pool,async client=>{
      assert.equal((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'repeatable read');
      const row=(await client.query('SELECT assurance_level,revoked_at FROM platform_sessions WHERE id=$1',[normalId])).rows[0];
      assert.equal(row.assurance_level,'mfa');assert.equal(row.revoked_at,null);
      await client.query('INSERT INTO synthetic_continuation_probe(id,source_session) VALUES($1,$2)',[randomUUID(),normalId]);
    },{ isolationLevel: 'REPEATABLE READ' });
    return { approved: true };
  });
  const active=await sessions.resolvePrincipal({ headers: { cookie: completed.setCookies[0].split(';')[0] } });
  assert.equal(active.session.id,normalId);assert.equal(active.assurance.level,'mfa');
  const currentRequest={ headers: { cookie: completed.setCookies[0].split(';')[0] } };
  assert.equal(await createPlatformSessionService(sessionOptions).resolvePrincipal(currentRequest),null);
  for (const scope of [{ environment: 'dev',protectedSecurityEpoch: epoch },
    { environment: 'prod',protectedSecurityEpoch: epoch },{ environment: 'int',protectedSecurityEpoch: randomUUID() }]) {
    assert.equal(await createProtectedPlatformSessions({ ...sessionOptions,...scope }).resolvePrincipal(currentRequest),null);
  }
  assert.equal(await createProtectedPlatformSessions({ ...sessionOptions,environment: 'int',
    protectedSecurityEpoch: epoch,securityEpoch: 8 }).resolvePrincipal(currentRequest),null);
  assert.equal(await sessions.resolvePrincipal(input.request),null);
  assert.ok((await pool.query('SELECT revoked_at FROM platform_sessions WHERE id=$1',[temporaryId])).rows[0].revoked_at);
  const before=(await pool.query(`SELECT (SELECT count(*)::int FROM platform_sessions WHERE operator_id=$1) AS sessions,
    (SELECT count(*)::int FROM synthetic_continuation_probe) AS mutations,
    (SELECT updated_at FROM platform_operators WHERE id=$1) AS stamp`,[operatorId])).rows[0];
  const next=await scopes.withShared(()=>service.startStepUp(active,{ operationHash }));
  let rejectedNormal;
  await assert.rejects(service.executeStepUpWithContinuation({
    cookie: readPlatformPasskeyTransactionCookie({ cookie: next.setCookie.split(';')[0] }),state: next.state,operationHash,
    response: keys[0].response('get',{ counter: 2,client: { challenge: next.options.challenge } }),
    request: { headers: { cookie: completed.setCookies[0].split(';')[0] } },
  },async context=>{
    rejectedNormal=service.verifiedOperationWithContinuation(context,operationHash).continuationPrincipal.session.id;
    await withPostgresTransaction(pool,client=>client.query('INSERT INTO synthetic_continuation_probe(id,source_session) VALUES($1,$2)',
      [randomUUID(),rejectedNormal]),{ isolationLevel: 'REPEATABLE READ' });
    throw new Error('SYNTHETIC_CONTINUATION_MUTATION_FAILED');
  }),/SYNTHETIC_CONTINUATION_MUTATION_FAILED/);
  assert.deepEqual((await pool.query(`SELECT (SELECT count(*)::int FROM platform_sessions WHERE operator_id=$1) AS sessions,
    (SELECT count(*)::int FROM synthetic_continuation_probe) AS mutations,
    (SELECT updated_at FROM platform_operators WHERE id=$1) AS stamp`,[operatorId])).rows[0],before);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM platform_sessions WHERE id=$1',[rejectedNormal])).rows[0].count,0);
  assert.equal((await sessions.resolvePrincipal({ headers: { cookie: completed.setCookies[0].split(';')[0] } })).session.id,normalId);
  assert.equal(Number((await pool.query('SELECT signature_counter FROM platform_passkey_credentials WHERE credential_id=$1',
    [keys[0].credential.id])).rows[0].signature_counter),1);
});
