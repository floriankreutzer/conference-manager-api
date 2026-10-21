import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createProtectedSyntheticCustomerAccess } from '../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';
import { migrateUp,rollbackToVersion } from '../scripts/db-migrations.mjs';

function deferred() { let resolve;const promise=new Promise(done=>{ resolve=done; });return { promise,resolve }; }
// Isolated fixture only: actual session_user/current_user, without a production
// credential/TLS claim. Connections are discarded after changing authorization.
function asSessionUser(base,role) {
  if (!['cm_protected_int_customer','cm_protected_int_platform'].includes(role)) throw new Error('FIXTURE_ROLE_INVALID');
  async function connect() {
    const client=await base.connect();
    try { await client.query(`SET SESSION AUTHORIZATION "${role}"`); }
    catch (error) { client.release(true);throw error; }
    return { query: (...args)=>client.query(...args),release: ()=>client.release(true) };
  }
  return { connect,async query(...args) { const client=await connect();try { return await client.query(...args); }
    finally { client.release(); } } };
}

test('native Customer source-lock capability fences actual approved P256 custody without Platform SELECT or UPDATE privileges',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const target=new URL(database.databaseUrl);
  if (!['localhost','127.0.0.1'].includes(target.hostname)
    || !/^\/conference_manager_test_\d+_\d+$/.test(target.pathname)) throw new Error('ISOLATED_ROLE_FIXTURE_DATABASE_REQUIRED');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const ownerLease=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const business=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const lease=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 }),created=[];
  const release=deferred();
  t.after(async()=>{
    release.resolve();await Promise.all([ownerLease.end(),business.end(),lease.end(),control.end()]);
    try { for (const role of created.reverse()) { await pool.query(`DROP OWNED BY "${role}"`);await pool.query(`DROP ROLE "${role}"`); } }
    finally { await pool.end(); }
  });await migrateUp(pool);
  const signature='public.protected_lock_synthetic_handoff_source(text,uuid,uuid)';
  const publicRights=await pool.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(routine.proacl,pg_catalog.acldefault('f',routine.proowner))) privilege
    WHERE routine.oid=$1::regprocedure AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'`,[signature]);
  assert.equal(publicRights.rows[0].count,0);
  // Existing global roles are never adopted or changed. Only these newly
  // created fixture roles are cleaned up, inside a generated loopback database.
  for (const role of ['cm_protected_int_customer','cm_protected_int_platform']) {
    await pool.query(`CREATE ROLE "${role}" LOGIN`);created.push(role);
    await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await pool.query(`GRANT SELECT ON protected_runtime_deployments TO "${role}"`);
    await pool.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${role}"`);
  }
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://customer-int.example.test',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,ownerLease,{ epoch });
  const authorizationPolicy=createPlatformAuthorizationPolicy();
  const generationService=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,passkeyService: owner.auth,
    authorizationPolicy,repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
      tenantAuditRepository: createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) }),
      platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const customer=createProtectedSyntheticCustomerAccess({ pool,leasePool: ownerLease,scope,
    browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48),auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48) });
  const start=await customer.start('127.0.0.1'),binding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });
  t.after(()=>binding.destroy());
  const service=createSyntheticHandoffService({ scope,browserBinding: binding,passkeyService: owner.auth,authorizationPolicy,
    repository: createPostgresSyntheticHandoffRepository(pool,{ scope,browserBinding: binding,
      platformAuditRepository: owner.auditRepository }) });
  const restricted=asSessionUser(business,'cm_protected_int_customer'),wrongSurface=asSessionUser(business,'cm_protected_int_platform');
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: restricted,
    leasePool: asSessionUser(lease,'cm_protected_int_customer'),environment: 'int',securityEpoch: epoch });
  async function lock(client,{ environment='int',securityEpoch=epoch,flowId=start.flowId }={}) {
    return (await client.query('SELECT public.protected_lock_synthetic_handoff_source($1,$2,$3) AS locked',
      [environment,securityEpoch,flowId])).rows[0].locked;
  }
  assert.equal(await scopes.withShared(()=>lock(restricted)),false);
  const selection={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,
    generationId: generation.generationId,slot: 'northwind',role: 'employee' };
  const hash=await owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,intent: selection }));
  await owner.executeWithContinuation(hash,proofContext=>service.approve({ proofContext,intent: selection,correlationId: randomUUID() }));
  const sourceId=owner.current().principal.session.id;
  const identity=(await restricted.query('SELECT current_user::text AS current_role,session_user::text AS session_role')).rows[0];
  assert.deepEqual(identity,{ current_role: 'cm_protected_int_customer',session_role: 'cm_protected_int_customer' });
  await assert.rejects(restricted.query('SELECT id FROM platform_sessions LIMIT 1'),{ code: '42501' });
  await assert.rejects(restricted.query('UPDATE platform_operators SET status=status WHERE id=$1',[owner.operatorId]),{ code: '42501' });
  assert.equal(await lock(wrongSurface),false);
  for (const change of [{ environment: 'dev' },{ environment: 'prod' },{ securityEpoch: randomUUID() },{ flowId: randomUUID() }]) {
    assert.equal(await scopes.withShared(()=>lock(restricted,change)),false);
  }
  const revoker=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,entered=deferred();
  const held=scopes.withShared(()=>withPostgresTransaction(restricted,async client=>{
    assert.equal(await lock(client),true);entered.resolve((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await release.promise;
  },{ isolationLevel: 'REPEATABLE READ' }));
  const holder=await Promise.race([entered.promise,held.then(()=>{ throw new Error('SOURCE_LOCK_NOT_ENTERED'); })]);
  const rolledBack=assert.rejects(withPostgresTransaction(pool,async client=>{
    await client.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[sourceId]);
    throw new Error('SOURCE_LOCK_PROBE_ROLLBACK');
  }),/SOURCE_LOCK_PROBE_ROLLBACK/);
  try {
    let blocked=false;const deadline=Date.now()+5000;
    while (Date.now()<deadline) {
      const row=(await control.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked',[revoker,holder])).rows[0];
      if (row.blocked) { blocked=true;break; }await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(blocked,true,'actual source revocation must wait for the same-transaction shared row lock');
  } finally { release.resolve();await held;await rolledBack; }
  assert.equal((await pool.query('SELECT revoked_at FROM platform_sessions WHERE id=$1',[sourceId])).rows[0].revoked_at,null);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM sessions WHERE provider='platform_delegation'")).rows[0].count,0);
  await assert.rejects(rollbackToVersion(pool,61),/SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
});
