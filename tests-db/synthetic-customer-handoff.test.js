import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticCustomerAccess } from '../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';
import { createPostgresProtectedInvitedSessionRepository } from '../src/persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedCustomerAccessRepository } from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

const headers=cookie=>({ headers: { cookie: cookie.split(';')[0] } });
test('native handoff binds actual signed continuation, original browser, one-use session, current source and explicit account switching',
async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const real=await createInvitedCustomerFixture(pool,t);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const protection={ environment: 'int',securityEpoch: epoch };
  const realSessions=createProtectedInvitedCustomerSessions({ ...protection,
    sessionRepository: createPostgresProtectedInvitedSessionRepository(pool,{ ...protection,auditRepository: real.auditRepository }),
    accessRepository: createPostgresProtectedCustomerAccessRepository(pool,protection),auditService: real.auditService,
    publicOrigin: scope.customerOrigin,csrfSecret: 's'.repeat(48) });
  const realSession=await realSessions.issue({ tenantId: real.tenantId,userId: real.principal.userId,
    providerIdentity: real.principal.providerIdentity,roles: real.principal.roles,permissions: real.principal.permissions,
    securityVersion: real.principal.session.securityVersion },{ correlationId: randomUUID() });
  const options={ pool,leasePool,scope,browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48),
    auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48) };
  const customer=createProtectedSyntheticCustomerAccess(options);
  assert.ok(await customer.sessionService.resolvePrincipal(headers(realSession.setCookie)));
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret: options.browserSecret });t.after(()=>binding.destroy());
  const service=createSyntheticHandoffService({ scope,browserBinding: binding,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticHandoffRepository(pool,
      { scope,browserBinding: binding,platformAuditRepository: owner.auditRepository }) });
  const generationService=createSyntheticGenerationService({ ...protection,passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,
      { ...protection,tenantAuditRepository: real.auditRepository,platformAuditRepository: owner.auditRepository }) });
  const generationIntent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(generationIntent),proofContext=>generationService.replace({
    proofContext,intent: generationIntent,correlationId: randomUUID() }));
  async function approve(start,slot,role,changes={}) {
    const intent={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,generationId: generation.generationId,slot,role,
      ...changes };
    const hash=await owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,intent }));
    const redirect=await owner.executeWithContinuation(hash,proofContext=>service.approve({
      proofContext,intent,correlationId: randomUUID() }));
    const url=new URL(redirect.location);assert.equal(url.origin,scope.customerOrigin);
    assert.equal(url.pathname,'/api/v1/auth/delegation/callback');assert.equal(url.searchParams.get('state'),start.state);
    return { flowId: start.flowId,state: start.state,browserToken: start.browserToken,code: url.searchParams.get('code') };
  }
  const count=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM sessions) AS sessions,
    (SELECT count(*)::int FROM audit_events) AS audit,
    (SELECT count(*)::int FROM synthetic_customer_handoffs WHERE status='consumed') AS consumed`)).rows[0];
  const first=await customer.start('127.0.0.1');assert.equal(first.status,'started');
  const before=await count(),callback=await approve(first,'northwind','employee');
  const row=(await pool.query('SELECT * FROM synthetic_customer_handoffs WHERE id=$1',[first.flowId])).rows[0];
  assert.equal(row.status,'approved');assert.notEqual(row.code_verifier,callback.code);
  assert.equal(row.source_platform_session_id,owner.current().principal.session.id);
  assert.equal(owner.current().principal.assurance.level,'mfa');assert.equal(row.customer_session_id,null);
  assert.deepEqual(await count(),before);
  await assert.rejects(customer.callback({ ...callback,browserToken: Buffer.alloc(32,9).toString('base64url') }),/DENIED/);
  await assert.rejects(customer.callback({ ...callback,code: Buffer.alloc(32,9).toString('base64url') }),/DENIED/);
  await assert.rejects(customer.callback({ ...callback,state: Buffer.alloc(32,9).toString('base64url') }),/DENIED/);
  const confirmation=await customer.callback(callback);
  const choice=await customer.confirmation({ ...callback,completion: confirmation.completion });
  assert.deepEqual(Object.keys(choice).sort(),['csrfToken','role','slot']);assert.equal(choice.role,'employee');
  assert.deepEqual(await count(),before);
  const input={ flowId: first.flowId,browserToken: first.browserToken,completion: confirmation.completion,
    csrfToken: choice.csrfToken,request: { headers: {} },correlationId: randomUUID() };
  await assert.rejects(customer.complete({ ...input,csrfToken: '0'.repeat(64) }),/DENIED/);
  // A genuine protected REAL login occurring between callback GET and final
  // same-origin POST must survive; neither its cookie nor its session is replaced.
  await assert.rejects(customer.complete({ ...input,request: headers(realSession.setCookie) }),/LOGOUT_REQUIRED/);
  assert.ok(await customer.sessionService.resolvePrincipal(headers(realSession.setCookie)));
  assert.deepEqual(await count(),before);
  const completed=await Promise.allSettled([customer.complete(input),customer.complete({ ...input,correlationId: randomUUID() })]);
  assert.equal(completed.filter(result=>result.status==='fulfilled').length,1);
  const session=completed.find(result=>result.status==='fulfilled').value;
  assert.deepEqual(session.principal.roles,['employee']);assert.equal(session.principal.tenantId,generation.tenants[0].tenantId);
  assert.equal((await count()).sessions,before.sessions+1);assert.equal((await count()).consumed,1);
  assert.equal((await customer.sessionService.resolvePrincipal(headers(session.setCookie))).session.id,session.principal.session.id);
  await assert.rejects(customer.callback(callback),/DENIED/);
  await assert.rejects(customer.complete(input),/DENIED/);
  await assert.rejects(pool.query("UPDATE sessions SET expires_at=expires_at+interval '1 hour' WHERE id=$1",
    [session.principal.session.id]),/SYNTHETIC_HANDOFF_SESSION_IMMUTABLE/);

  let previous=session;
  for (const [slot,role] of [['contoso','conference_manager'],['fabrikam','tenant_admin']]) {
    const start=await customer.start('127.0.0.2'),next=await approve(start,slot,role);
    // Fresh exact approval revoked the former source MFA. Its old Customer
    // session loses business access, yet same-owner replacement may revoke it.
    assert.equal(await customer.sessionService.resolvePrincipal(headers(previous.setCookie)),null);
    const pending=await customer.callback(next),view=await customer.confirmation({ ...next,completion: pending.completion });
    const issued=await customer.complete({ flowId: start.flowId,browserToken: start.browserToken,completion: pending.completion,
      csrfToken: view.csrfToken,request: headers(previous.setCookie),correlationId: randomUUID() });
    assert.deepEqual(issued.principal.roles,['employee',role]);
    assert.equal(issued.principal.tenantId,generation.tenants.find(tenant=>tenant.slot===slot).tenantId);
    assert.ok((await pool.query('SELECT revoked_at FROM sessions WHERE id=$1',[previous.principal.session.id])).rows[0].revoked_at);
    previous=issued;assert.ok(await customer.sessionService.resolvePrincipal(headers(issued.setCookie)));
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM synthetic_customer_handoffs
    WHERE status='consumed'`)).rows[0].count,3);
  assert.equal(await real.auditRepository.verifyTenantChain(real.tenantId),true);
  for (const tenant of generation.tenants) assert.equal(await real.auditRepository.verifyTenantChain(tenant.tenantId),true);
  assert.ok(await realSessions.resolvePrincipal(headers(realSession.setCookie)));
  await t.test('actual signed approval cannot cross the database owner-slot bound and rolls continuation/audit back',async()=>{
    const start=await customer.start('127.0.0.5');
    const snapshot=async()=>(await pool.query(`SELECT
      (SELECT count(*)::int FROM platform_sessions WHERE operator_id=$1) AS sessions,
      (SELECT count(*)::int FROM platform_audit_events) AS audit,
      (SELECT signature_counter FROM platform_passkey_credentials WHERE credential_id=$2) AS counter`,
    [owner.operatorId,owner.keys[0].credential.id])).rows[0];
    const before=await snapshot();
    await pool.query(`CREATE FUNCTION synthetic_handoff_test_owner_bound() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.owner_slot:=513;RETURN NEW;END $$`);
    await pool.query(`CREATE TRIGGER zz_synthetic_handoff_test_owner_bound BEFORE UPDATE ON synthetic_customer_handoffs
      FOR EACH ROW WHEN(NEW.status='approved') EXECUTE FUNCTION synthetic_handoff_test_owner_bound()`);
    try {
      await assert.rejects(approve(start,'northwind','employee'),
        { code: '23514',constraint: 'synthetic_handoff_owner_slot_valid' });
      assert.deepEqual(await snapshot(),before);
      assert.equal((await pool.query('SELECT status FROM synthetic_customer_handoffs WHERE id=$1',
        [start.flowId])).rows[0].status,'pending');
      assert.ok(await owner.sessions.resolvePrincipal(headers(owner.current().setCookie)));
    } finally {
      await pool.query('DROP TRIGGER zz_synthetic_handoff_test_owner_bound ON synthetic_customer_handoffs');
      await pool.query('DROP FUNCTION synthetic_handoff_test_owner_bound()');
    }
  });
  await t.test('bounded source starts and private retained custody reject bypass and destructive rollback',async()=>{
    for (let index=0;index<5;index++) assert.equal((await customer.start('127.0.0.3')).status,'started');
    const before=await count(),rows=(await pool.query('SELECT count(*)::int AS count FROM synthetic_customer_handoffs')).rows[0].count;
    assert.equal((await customer.start('127.0.0.3')).status,'limited');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_customer_handoffs')).rows[0].count,rows);
    assert.deepEqual(await count(),before);
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063; retain the populated062 recovery guard.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063; retain the populated062 recovery guard.
    await assert.rejects(rollbackLatest(pool),/SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
    await assert.rejects(pool.query('TRUNCATE synthetic_customer_handoffs'),/SYNTHETIC_HANDOFF_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
    await assert.rejects(pool.query('DELETE FROM synthetic_customer_handoffs WHERE id=$1',[first.flowId]),
      /SYNTHETIC_HANDOFF_RETENTION_REQUIRED/);
    const audit=(await pool.query(`SELECT metadata FROM platform_audit_events
      WHERE action='platform.synthetic_access.approved' ORDER BY sequence`)).rows;
    assert.equal(audit.length,3);
    for (const event of audit) assert.deepEqual(Object.keys(event.metadata).sort(),['generationId','mode','role','slot']);
  });
  await t.test('foreign owner and fabricated proof context cannot approve an owned slot',async()=>{
    const start=await customer.start('127.0.0.4');
    const intent={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,
      generationId: generation.generationId,slot: 'northwind',role: 'employee' };
    await assert.rejects(service.approve({ proofContext: {},intent,correlationId: randomUUID() }));
    await assert.rejects(owner.scopes.withShared(()=>service.operationHash({ principal: owner.current().principal,
      intent: { ...intent,operatorId: randomUUID() } })),/DENIED/);
    const foreign=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch });
    await assert.rejects(foreign.scopes.withShared(()=>service.operationHash({ principal: foreign.current().principal,
      intent: { ...intent,operatorId: foreign.operatorId } })),/DENIED/);
    assert.equal((await pool.query('SELECT status FROM synthetic_customer_handoffs WHERE id=$1',
        [start.flowId])).rows[0].status,'pending');
  });
  const lastCookie=previous.setCookie;
  await owner.sessions.revoke(owner.current().principal,{ correlationId: randomUUID() });
  assert.equal(await customer.sessionService.resolvePrincipal(headers(lastCookie)),null);
  assert.ok(await customer.sessionService.resolvePrincipal(headers(realSession.setCookie)));
  const nextEpoch=randomUUID();
  await pool.query(`UPDATE protected_runtime_deployments
    SET security_epoch=$1,revision=revision+1,updated_at=clock_timestamp() WHERE environment='int'`,
    [nextEpoch]);
  await assert.rejects(customer.start('127.0.0.1'),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  const next=createProtectedSyntheticCustomerAccess({ ...options,scope: { ...scope,securityEpoch: nextEpoch } });
  assert.equal(await next.sessionService.resolvePrincipal(headers(lastCookie)),null);
  assert.equal(await next.sessionService.resolvePrincipal(headers(realSession.setCookie)),null);
});
