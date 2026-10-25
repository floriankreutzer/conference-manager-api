import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedRuntimeReadiness } from '../src/persistence/postgres/protected-runtime-readiness.js';
import { createPostgresProtectedRealTenantScope } from '../src/persistence/postgres/protected-real-tenant-scope.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createProtectedSyntheticCustomerAccess } from '../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';

// Generated loopback test database only. This is actual restricted SQL session
// authorization; it is not password/TLS authentication or a complete process root.
function restrictedPool(base,role) {
  if (!['cm_protected_int_customer','cm_protected_int_platform'].includes(role)) throw new Error('FIXTURE_ROLE_INVALID');
  async function connect() {
    const client=await base.connect();
    try { await client.query(`SET SESSION AUTHORIZATION "${role}"`); }
    catch (error) { client.release(true);throw error; }
    return { query: (...args)=>client.query(...args),release: ()=>client.release(true) };
  }
  return { connect,async query(...args) { const client=await connect();
    try { return await client.query(...args); } finally { client.release(); } } };
}

test('native operator grants fence both roles and complete signed Customer delegation with no Platform mutation or private key reads',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const target=new URL(database.databaseUrl);
  if (!['localhost','127.0.0.1'].includes(target.hostname)
    || !/^\/conference_manager_test_\d+_\d+$/.test(target.pathname)) throw new Error('ISOLATED_ROLE_FIXTURE_DATABASE_REQUIRED');
  const makePool=()=>createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const pool=makePool(),ownerLease=makePool(),business=makePool(),lease=makePool(),created=[];
  t.after(async()=>{
    await Promise.all([ownerLease.end(),business.end(),lease.end()]);
    try { for (const role of created.reverse()) { await pool.query(`DROP OWNED BY "${role}"`);await pool.query(`DROP ROLE "${role}"`); } }
    finally { await pool.end(); }
  });await migrateUp(pool);
  const epoch=randomUUID(),protection={ environment: 'int',securityEpoch: epoch };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  for (const role of ['cm_protected_int_customer','cm_protected_int_platform']) {
    await pool.query(`CREATE ROLE "${role}" LOGIN`);created.push(role);
  }
  await assert.rejects(grantProtectedRuntimeRoles(pool,{ ...protection,securityEpoch: randomUUID() }),
    { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  await pool.query('GRANT USAGE ON SEQUENCE audit_events_id_seq TO cm_protected_int_customer');
  await assert.rejects(grantProtectedRuntimeRoles(pool,protection),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  await pool.query('REVOKE USAGE ON SEQUENCE audit_events_id_seq FROM cm_protected_int_customer');
  const installed=await grantProtectedRuntimeRoles(pool,protection);assert.deepEqual(installed.roles,created);
  await assert.rejects(grantProtectedRuntimeRoles(pool,protection),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  const restricted=restrictedPool(business,created[0]),restrictedLease=restrictedPool(lease,created[0]);
  const platform=restrictedPool(business,created[1]);
  for (const [surface,selected] of [['customer',restricted],['platform',platform]]) {
    assert.equal(await createPostgresProtectedRuntimeReadiness(selected,{ ...protection,surface,
      leasePool: restrictedPool(lease,`cm_protected_int_${surface}`) }).isReady(),true);
    await assert.rejects(selected.query('SELECT public.mark_request_attribution_used()'),{ code: '42501' });
  }
  for (const query of ['SELECT token_hash FROM platform_sessions','SELECT public_key FROM platform_passkey_credentials',
    'SELECT * FROM platform_operators','UPDATE platform_operators SET status=status','TRUNCATE rooms',
    'UPDATE tenant_runtime_registry SET mode=mode']) await assert.rejects(restricted.query(query),{ code: '42501' });
  await assert.rejects(restricted.query('UPDATE protected_runtime_deployments SET updated_at=updated_at'),{ code: '42501' });
  for (const query of ['SELECT payload_envelope FROM customer_access_deliveries',
    'INSERT INTO platform_passkey_enrollment_grants DEFAULT VALUES','INSERT INTO sessions DEFAULT VALUES',
    'CREATE TABLE public.forbidden_fixture(id integer)']) await assert.rejects(platform.query(query),{ code: '42501' });

  for (const name of ['platform_runtime_deployments','platform_runtime_tenant_mappings','platform_diagnostic_events',
    'platform_metering_periods','platform_operational_quotas']) {
    assert.equal((await platform.query(`SELECT * FROM public."${name}" LIMIT 0`)).rowCount,0);
    await assert.rejects(restricted.query(`SELECT * FROM public."${name}" LIMIT 0`),{ code: '42501' });
    await assert.rejects(platform.query(`DELETE FROM public."${name}" WHERE false`),{ code: '42501' });
  }

  const realTenant=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Isolated REAL admission fixture','onboarding')",[realTenant]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[realTenant]);
  const real=createPostgresProtectedRealTenantScope(restricted,protection);
  const customerScopes=createPostgresProtectedRuntimeExecutionScopes({ ...protection,pool: restricted,leasePool: restrictedLease });
  await customerScopes.withShared(async()=>{
    await withPostgresTransaction(restricted,async client=>{
      assert.equal(await real.allowsWithClient(client,realTenant),true);
      assert.equal(await real.lockAdmissionWithClient(client,realTenant),true);
    });
    await assert.rejects(pool.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,
      revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,[randomUUID()]),{ code: '55P03' });
    assert.equal((await pool.query("SELECT security_epoch FROM protected_runtime_deployments WHERE environment='int'"))
      .rows[0].security_epoch,epoch);
  });

  const owner=await createProtectedSyntheticOperatorFixture(pool,ownerLease,{ epoch });
  const authorizationPolicy=createPlatformAuthorizationPolicy(),audit=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const generationService=createSyntheticGenerationService({ ...protection,passkeyService: owner.auth,authorizationPolicy,
    repository: createPostgresSyntheticGenerationRepository(pool,{ ...protection,tenantAuditRepository: audit,
      platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const scope={ ...protection,platformSecurityEpoch: 7,customerOrigin: 'https://customer-int.example.test',
    platformOrigin: 'https://ops-int.example.com' };
  const customer=createProtectedSyntheticCustomerAccess({ pool: restricted,leasePool: restrictedLease,scope,
    browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48),auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48) });
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });t.after(()=>binding.destroy());
  const service=createSyntheticHandoffService({ scope,browserBinding: binding,passkeyService: owner.auth,authorizationPolicy,
    repository: createPostgresSyntheticHandoffRepository(pool,{ scope,browserBinding: binding,
      platformAuditRepository: owner.auditRepository }) });
  const start=await customer.start('127.0.0.1');assert.equal(start.status,'started');
  const selection={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,
    generationId: generation.generationId,slot: 'northwind',role: 'employee' };
  const hash=await owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,intent: selection }));
  const approved=await owner.executeWithContinuation(hash,proofContext=>service.approve({
    proofContext,intent: selection,correlationId: randomUUID() }));
  const callback={ flowId: start.flowId,state: start.state,browserToken: start.browserToken,
    code: new URL(approved.location).searchParams.get('code') };
  const confirmation=await customer.callback(callback);
  const choice=await customer.confirmation({ ...callback,completion: confirmation.completion });
  const input={ flowId: start.flowId,browserToken: start.browserToken,completion: confirmation.completion,
    csrfToken: choice.csrfToken,request: { headers: {} },correlationId: randomUUID() };
  await assert.rejects(customer.complete({ ...input,csrfToken: '0'.repeat(64) }),/DENIED/);
  const session=await customer.complete(input),request={ headers: { cookie: session.setCookie.split(';')[0] } };
  assert.deepEqual(session.principal.roles,['employee']);
  assert.equal((await customer.sessionService.resolvePrincipal(request)).session.id,session.principal.session.id);
  await assert.rejects(customer.complete(input),/DENIED/);
  await pool.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[owner.current().principal.session.id]);
  assert.equal(await customer.sessionService.resolvePrincipal(request),null);
  assert.equal(await audit.verifyTenantChain(session.principal.tenantId),true);
});
