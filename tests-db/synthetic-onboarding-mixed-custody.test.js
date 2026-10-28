import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createProtectedSyntheticCustomerAccess } from '../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createPostgresSyntheticHandoffRepository } from '../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createSyntheticHandoffService } from '../src/platform/application/synthetic-handoff-service.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';
import { createPostgresProtectedParticipantSessionRepository } from '../src/persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedParticipantCustomerAccessRepository }
  from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createPostgresSyntheticOnboardingRepository } from '../src/persistence/postgres/synthetic-onboarding-repository.js';
import { createSyntheticOnboardingService } from '../src/application/synthetic-onboarding-service.js';

test('one native max-one connection alternates delegated and invited Admin lifecycle wrappers without prepared SQL collision',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[];
  function database(url) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href),lease=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(value=>value.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);const epoch=randomUUID(),protection={ environment: 'int',securityEpoch: epoch };
  const scope={ ...protection,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  assert.match(fixture.password,/^[a-f0-9]{64}$/);
  for (const surface of ['customer','platform']) {
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${fixture.password}'`);
  }
  await grantProtectedRuntimeRoles(pool,protection);
  const owner=await createProtectedSyntheticMicrosoftFixture(pool,lease,{ epoch });
  const tenantAudit=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const generationService=createSyntheticGenerationService({ ...protection,assuranceMode: 'microsoft_mfa',passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,
      { ...protection,assuranceMode: 'microsoft_mfa',calendarEnabled: true,
        tenantAuditRepository: tenantAudit,platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  const url=new URL(fixture.url);url.username='cm_protected_int_customer';
  const customerPool=database(url.href),customerLease=database(url.href);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: customerPool,leasePool: customerLease,...protection });
  const delegated=createProtectedSyntheticCustomerAccess({ pool: customerPool,leasePool: customerLease,scope,
    browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48) });
  const binding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });t.after(()=>binding.destroy());
  const handoff=createSyntheticHandoffService({ scope,assuranceMode: 'microsoft_mfa',passkeyService: owner.auth,
    authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticHandoffRepository(pool,
      { scope,binding,platformAuditRepository: owner.auditRepository }) });
  const start=await delegated.start('127.0.0.1');assert.equal(start.status,'started');
  const selected={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,
    generationId: generation.generationId,slot: 'fabrikam',role: 'tenant_admin' };
  const hash=await owner.scopes.withShared(()=>handoff.operationHash({ principal: owner.current().principal,intent: selected }));
  const redirect=await owner.executeWithContinuation(hash,proofContext=>handoff.approve({ proofContext,intent: selected,
    correlationId: randomUUID() }));
  const callback={ flowId: start.flowId,state: start.state,browserToken: start.browserToken,
    code: new URL(redirect.location).searchParams.get('code') };
  const confirmed=await delegated.callback(callback),choice=await delegated.confirmation({ ...callback,completion: confirmed.completion });
  const admitted=await delegated.complete({ flowId: start.flowId,browserToken: start.browserToken,completion: confirmed.completion,
    csrfToken: choice.csrfToken,request: { headers: {} },correlationId: randomUUID() });
  const tenantId=admitted.principal.tenantId;
  const invited=await createInvitedCustomerFixture(pool,t,{ targetTenantId: tenantId,recipient: 'Mixed@example.test',
    async beforeAdmission({ invitation }) {
      await pool.query(`INSERT INTO synthetic_invited_memberships
        (environment,tenant_id,membership_id,invitation_id,generation_id,operator_id,slot)
        SELECT 'int',$1,membership_id,id,$3,$4,'fabrikam' FROM customer_member_invitations
        WHERE environment='int' AND tenant_id=$1 AND id=$2`,[tenantId,invitation.id,generation.generationId,owner.operatorId]);
    } });
  const authorizationPolicy=createAuthorizationPolicy(),auditRepository=createPostgresAuditRepository(customerPool,
    { hmacSecret: 'a'.repeat(48) }),auditService=createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions=createProtectedInvitedCustomerSessions({ ...protection,syntheticParticipantsEnabled: true,
    sessionRepository: createPostgresProtectedParticipantSessionRepository(customerPool,{ ...protection,auditRepository }),
    accessRepository: createPostgresProtectedParticipantCustomerAccessRepository(customerPool,protection),auditService,
    publicOrigin: scope.customerOrigin,csrfSecret: 's'.repeat(48) });
  const identity={ tenantId,userId: invited.principal.userId,securityVersion: invited.principal.session.securityVersion,
    roles: invited.principal.roles,permissions: invited.principal.permissions,providerIdentity: invited.principal.providerIdentity };
  const session=await scopes.withShared(()=>sessions.issue(identity,{ correlationId: randomUUID() }));
  const principal=await scopes.withShared(()=>sessions.resolvePrincipal({ headers: { cookie: session.setCookie.split(';')[0] } }));
  assert.ok(principal);
  const service=createSyntheticOnboardingService({ authorizationPolicy,auditService,
    repository: createPostgresSyntheticOnboardingRepository(customerPool,
      { scope,syntheticParticipantsEnabled: true,auditRepository }) });
  const context=(value,status='onboarding')=>({ principal: value,tenantContext: { tenantId,status },correlationId: randomUUID() });
  const before=await scopes.withShared(()=>service.view(context(admitted.principal)));
  const imported=await scopes.withShared(()=>service.importRooms(context(admitted.principal),
    { expectedRevision: before.locationsRevision,selectedKeys: ['workshop','focus'] }));
  assert.equal(imported.importedCount,2);
  const ready=await scopes.withShared(()=>service.transition(context(admitted.principal),
    { expectedRevision: imported.locationsRevision,expectedStatus: 'onboarding',targetStatus: 'ready' }));
  assert.equal(ready.tenantStatus,'ready');
  const active=await scopes.withShared(()=>service.transition(context(principal,'ready'),
    { expectedRevision: ready.locationsRevision,expectedStatus: 'ready',targetStatus: 'active' }));
  assert.equal(active.tenantStatus,'active');
  await assert.rejects(scopes.withShared(()=>service.transition(context(admitted.principal),
    { expectedRevision: active.locationsRevision,expectedStatus: 'onboarding',targetStatus: 'ready' })),/SYNTHETIC_ONBOARDING_CONFLICT/);
  assert.equal(await tenantAudit.verifyTenantChain(tenantId),true);
});
