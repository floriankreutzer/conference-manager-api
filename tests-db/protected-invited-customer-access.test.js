import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { PLATFORM_ENTRA_PROVIDER } from '../src/domain/identity-provider.js';

test('native protected invited login filters REAL before capture, choices and atomic admission and binds pending flows to epoch',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const control=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end(),control.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const authorizationPolicy=createAuthorizationPolicy(),auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const auditService=createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions=createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const invitationService=createCustomerInvitationService({ environment: 'int',authorizationPolicy,auditService,
    repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,auditRepository,
      content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' }) }) });
  // Deliberate isolated ordinary authority fixtures produce candidate outbox;
  // they do not constitute protected login or real external identity grants.
  async function candidate(label,recipients=['Mixed@example.test']) {
    const tenantId=randomUUID(),userId=randomUUID();
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,$2,'onboarding')",[tenantId,`Synthetic ${label}`]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic invitation admin')",[tenantId,userId]);
    await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[tenantId,userId]);
    const session=await sessions.issue({ tenantId,userId,securityVersion: 1,...tenantAuthorizationSnapshot(['employee','tenant_admin']),
      providerIdentity: { provider: 'test_identity',reference: userId } },{ correlationId: randomUUID() });
    const invitation=(await invitationService.issueBatch({ principal: session.principal,tenantContext: { tenantId,status: 'onboarding' },
      correlationId: randomUUID() },{ commandId: randomUUID(),invitations: [
      ...recipients.map(recipient=>({ recipient,roles: ['tenant_admin'],locale: 'de' }))] }))[0];
    return { tenantId,invitationId: invitation.id,session };
  }
  const unclassified=await candidate('Unclassified',['Mixed@example.test','Unclassified@example.test']);
  const real=await candidate('Real'),synthetic=await candidate('Synthetic',['Mixed@example.test','Synthetic@example.test']);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const operatorId=randomUUID(),generationId=randomUUID();
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,roles)
    VALUES($1::uuid,$2,'synthetic-directory',$1::text,ARRAY['platform_tenant_operator'])`,[operatorId,PLATFORM_ENTRA_PROVIDER]);
  await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
    VALUES('int',$1,$2,1,$3)`,[generationId,operatorId,epoch]);
  for (const [index,slot] of ['northwind','contoso','fabrikam'].entries()) {
    const tenantId=index===0 ? synthetic.tenantId : randomUUID();
    if (index!==0) await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic slot','onboarding')",[tenantId]);
    await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generationId,operatorId,slot]);
  }
  await pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1",
    [generationId]);
  const configuration={ pool,leasePool,environment: 'int',securityEpoch: epoch,publicOrigin: 'https://127.0.0.1',cipher,
    auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48),emailFlowSecret: 'f'.repeat(48),
    emailCodeSecret: 'p'.repeat(48),emailSourceSecret: 'b'.repeat(48) };
  const access=createProtectedInvitedCustomerAccess(configuration),service=access.service,sourceAddress='127.0.0.1';
  const request=recipient=>service.request({ recipient,locale: 'de',sourceAddress });
  const row=async flow=>(await pool.query('SELECT * FROM customer_email_challenges WHERE id=$1',[flow.challengeId])).rows[0];
  const counts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,
    (SELECT count(*)::int FROM sessions) AS sessions,(SELECT count(*)::int FROM audit_events) AS audits,
    (SELECT count(*)::int FROM customer_access_deliveries WHERE purpose='mailbox_code') AS codes`)).rows[0];
  const before=await counts();
  for (const recipient of ['Unknown@example.test','Unclassified@example.test','Synthetic@example.test']) {
    const flow=await request(recipient),stored=await row(flow);
    assert.equal(flow.status,'code_required');assert.equal(stored.mailbox_id,null);assert.deepEqual(stored.admission_snapshot,[]);
    assert.equal((await service.pending(flow)).status,'code_required');
    assert.equal((await service.verify({ ...flow,sourceAddress,code: '00000000' })).status,'rejected');
  }
  assert.deepEqual(await counts(),before);
  const flow=await request('Mixed@example.test'),captured=await row(flow);
  assert.equal(captured.admission_snapshot.length,1);assert.equal(captured.admission_snapshot[0].tenantId,real.tenantId);
  async function codeFor(challenge) {
    const delivery=(await pool.query("SELECT * FROM customer_access_deliveries WHERE purpose='mailbox_code' AND challenge_id=$1",
      [challenge.id])).rows[0];
    const bytes=cipher.open(delivery.payload_envelope,{ environment: 'int',mailboxId: delivery.mailbox_id,recordId: delivery.id,
      purpose: 'mailbox_code',tenantId: null });
    try { const match=JSON.parse(bytes.toString('utf8')).text.match(/\b\d{8}\b/);assert.ok(match);return match[0]; }
    finally { bytes.fill(0); }
  }
  const choice=await service.verify({ ...flow,sourceAddress,code: await codeFor(captured) });
  assert.equal(choice.status,'membership_required');
  const choices=await service.choices(choice);
  assert.deepEqual(choices.items,[{ membershipId: captured.admission_snapshot[0].membershipId,displayName: 'Synthetic Real' }]);
  // A later REAL invitation must not expand the already captured mailbox proof.
  const late=await candidate('Late Real');
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[late.tenantId]);
  assert.deepEqual(await service.choices(choice),choices);
  const nonreal=(await pool.query('SELECT membership_id FROM customer_member_invitations WHERE tenant_id=$1 LIMIT 1',
    [unclassified.tenantId])).rows[0].membership_id;
  const select=membershipId=>service.select({ ...choice,correlationId: randomUUID() },{ membershipId });
  const beforeDenied=await counts();assert.equal((await select(nonreal)).status,'rejected');assert.deepEqual(await counts(),beforeDenied);
  const results=await Promise.all([1,2].map(()=>select(choices.items[0].membershipId)));
  assert.deepEqual(results.map(result=>result.status).sort(),['authenticated','rejected']);
  const login=results.find(result=>result.status==='authenticated'),cookie=login.setCookie.split(';')[0];
  const principal=await access.sessionService.resolvePrincipal({ headers: { cookie } });
  assert.equal(principal.tenantId,real.tenantId);assert.deepEqual(principal.roles,['employee','tenant_admin']);
  assert.equal((await counts()).users,beforeDenied.users+1);assert.equal((await counts()).sessions,beforeDenied.sessions+1);
  assert.equal((await service.choices(choice)).status,'rejected');
  assert.equal(await auditRepository.verifyTenantChain(real.tenantId),true);
  // A fresh invited recipient produces a real queued code but no network call.
  await invitationService.issueBatch({ principal: real.session.principal,
    tenantContext: { tenantId: real.tenantId,status: 'onboarding' },correlationId: randomUUID() },
  { commandId: randomUUID(),invitations: [
    { recipient: 'Pending@example.test',roles: [],locale: 'en' },
    { recipient: 'Verified@example.test',roles: [],locale: 'en' }] });
  const pending=await request('Pending@example.test'),pendingRow=await row(pending),pendingCode=await codeFor(pendingRow);
  const verifiedFlow=await request('Verified@example.test'),verifiedRow=await row(verifiedFlow);
  const verified=await service.verify({ ...verifiedFlow,sourceAddress,code: await codeFor(verifiedRow) });
  assert.equal(verified.status,'membership_required');assert.equal((await service.choices(verified)).items.length,1);
  const budget=async()=>(await pool.query(`SELECT kind,key_hash,issue_count,failure_count,window_started_at,last_issued_at
    FROM customer_access_abuse_budgets WHERE environment='int' ORDER BY kind,key_hash`)).rows;
  const retained=await counts(),retainedBudget=await budget(),nextEpoch=randomUUID();
  await control.query(`UPDATE protected_runtime_deployments SET security_epoch=$1,revision=revision+1,
    updated_at=clock_timestamp() WHERE environment='int'`,[nextEpoch]);
  await assert.rejects(service.pending(pending),{ code: 'PROTECTED_RUNTIME_SCOPE_STALE' });
  const next=createProtectedInvitedCustomerAccess({ ...configuration,securityEpoch: nextEpoch });
  assert.equal((await next.service.pending(pending)).status,'rejected');
  assert.equal((await next.service.verify({ ...pending,code: pendingCode,sourceAddress })).status,'rejected');
  assert.equal((await next.service.choices(verified)).status,'rejected');
  assert.equal((await next.service.select({ ...verified,correlationId: randomUUID() },
    { membershipId: verifiedRow.admission_snapshot[0].membershipId })).status,'rejected');
  assert.equal(await next.sessionService.resolvePrincipal({ headers: { cookie } }),null);
  assert.deepEqual(await counts(),retained);assert.deepEqual(await budget(),retainedBudget);
  assert.equal((await row(pending)).verified_at,null);assert.equal((await row(pending)).attempt_count,0);
  assert.equal(await auditRepository.verifyTenantChain(real.tenantId),true);
});
