import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createPlatformAuthorizationPolicy,permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformOperationEvidenceFactory } from '../src/persistence/postgres/platform-operations-evidence.js';
import { createPostgresPlatformCustomerOnboardingRepository } from '../src/persistence/postgres/platform-customer-onboarding-repository.js';
import { createPlatformCustomerOnboardingService } from '../src/platform/application/customer-onboarding-service.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createPostgresPlatformCustomerInvitationRepository }
  from '../src/persistence/postgres/platform-customer-invitation-repository.js';
import { createPlatformCustomerInvitationAdministrationService }
  from '../src/platform/application/customer-invitation-administration-service.js';
import { createCustomerInvitationCustody } from '../src/persistence/postgres/customer-invitation-custody.js';
import { appendPlatformMutationEvidence } from '../src/persistence/postgres/platform-operations-repository.js';
import { authorizePlatformOperation } from '../src/platform/application/platform-operation-contract.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { normalizeCustomerInvitationBatch,normalizeCustomerInvitationIntent } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';
import { createPostgresPlatformTenantOperationsRepository } from '../src/persistence/postgres/platform-operations-repository.js';
import { createPostgresTenantOnboardingRepository } from '../src/persistence/postgres/tenant-onboarding-repository.js';
import { createPostgresTenantRepository } from '../src/persistence/postgres/tenant-repository.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';
import { createPostgresCustomerEmailChallengeRepository } from '../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from '../src/persistence/postgres/customer-email-admission-repository.js';
import { createCustomerEmailAdmissionService } from '../src/identity/customer-email-admission-service.js';


// An isolated migrated PostgreSQL database, real persisted Platform sessions and
// both real audit repositories. No provider or outbound transport is configured.
test('Platform creates owner-inclusive real customer invitations atomically without Customer impersonation',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const operatorId=randomUUID(),roles=['platform_tenant_operator'];
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,
    status,scope_mode,roles,created_at,updated_at)
    VALUES($1,'microsoft_entra_platform','synthetic-directory',$3,'active','all',$2,
      clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes')`,[operatorId,roles,operatorId]);
  const versionRow=await pool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operatorId]);
  const version=Number(versionRow.rows[0].security_version);
  const tenantAuditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });
  const platformAuditRepository=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'p'.repeat(48) });
  const platformAuthorizationPolicy=createPlatformAuthorizationPolicy();
  const tenantTargetPolicy=createPlatformTenantTargetPolicy({
    operatorRepository: createPostgresPlatformOperatorRepository(pool,{ auditRepository: platformAuditRepository }) });
  const tenantAuditService=createAuditService({ repository: tenantAuditRepository,authorizationPolicy: createAuthorizationPolicy() });
  const platformAuditService=createPlatformAuditService({ repository: platformAuditRepository,
    authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy });
  const operationEvidenceFactory=createPlatformOperationEvidenceFactory({ tenantAuditService,platformAuditService });
  const sessions=createPlatformSessionService({ repository: createPostgresPlatformSessionRepository(pool,
    { auditRepository: platformAuditRepository }),
    publicOrigin: 'https://127.0.0.1',csrfSecret: 'c'.repeat(48),securityEpoch: 7 });
  const issued=await sessions.issue({ operatorId,providerIdentity: { provider: 'microsoft_entra_platform',
    tenantReference: 'synthetic-directory',subjectReference: operatorId },roles,permissions: permissionsForPlatformRoles(roles),
    securityVersion: version,targetScope: { mode: 'all',securityVersion: version },
    assurance: { level: 'step_up',authenticationContext: 'synthetic-strong-proof',authenticatedAt: new Date().toISOString() } },
  { correlationId: randomUUID() });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const configuration={ environment: 'int',cipher,
    content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' }),
    tenantAuditRepository,platformAuditRepository };
  const repository=createPostgresPlatformCustomerOnboardingRepository(pool,configuration);
  const invitationContract={ normalizeIntent: normalizeCustomerInvitationIntent,
    normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations };
  function service(repo=repository) { return createPlatformCustomerOnboardingService({ repository: repo,platformAuthorizationPolicy,
    tenantTargetPolicy,operationEvidenceFactory,invitationContract,environment: 'int',
    ownerRecipient: 'Owner@example.test',idFactory: randomUUID }); }
  const input={ operatorContext: issued.principal,displayName: 'Real pilot',reason: 'Synthetic isolated acceptance',
    confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,displayName: 'Real pilot' },
    correlationId: randomUUID(),idempotencyKey: randomUUID(),invitations: [
      { recipient: 'Operator@example.test',roles: ['tenant_admin'],locale: 'en' },
      { recipient: 'Coordinator@example.test',roles: ['conference_manager'],locale: 'de' }] };
  async function counts() {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM tenants) tenants,(SELECT count(*)::int FROM users) users,
      (SELECT count(*)::int FROM sessions) sessions,(SELECT count(*)::int FROM customer_access_mailboxes) mailboxes,
      (SELECT count(*)::int FROM customer_member_invitations) invitations,(SELECT count(*)::int FROM customer_access_deliveries) deliveries,
      (SELECT count(*)::int FROM audit_events) audits,(SELECT count(*)::int FROM platform_audit_events) platform_audits,
      (SELECT count(*)::int FROM platform_operation_receipts) receipts`)).rows[0];
  }
  let created;
  await t.test('fresh creation atomically stores three invitations and both audit domains, never Customer Users or sessions',async()=>{
    const before=await counts();created=await service().createTenant(input);const after=await counts();
    assert.equal(created.invitations.length,3);assert.equal(created.invitations[2].recipient,'Owner@example.test');
    assert.equal(after.tenants-before.tenants,1);assert.equal(after.invitations-before.invitations,3);
    assert.equal(after.deliveries-before.deliveries,3);assert.equal(after.audits-before.audits,4);
    assert.equal(after.platform_audits-before.platform_audits,4);assert.equal(after.receipts-before.receipts,1);
    assert.equal(after.users,before.users);assert.equal(after.sessions,before.sessions);
    assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_onboarding_invitations')).rows[0].n,0);
    const audit=(await pool.query('SELECT actor_user_id,target_type,metadata FROM audit_events')).rows;
    assert.ok(audit.every(row=>row.actor_user_id===null && row.metadata.actorType==='platform_operator'));
    assert.equal(audit.filter(row=>row.target_type==='customer_invitation' && row.metadata.operation==='issue').length,3);
    assert.equal(await tenantAuditRepository.verifyTenantChain(created.tenant.id),true);
    const custody=await pool.query(`SELECT (SELECT jsonb_agg(to_jsonb(m)) FROM customer_access_mailboxes m) mailboxes,
      (SELECT jsonb_agg(to_jsonb(d)) FROM customer_access_deliveries d) deliveries,
      (SELECT jsonb_agg(result) FROM platform_operation_receipts) receipts`);
    assert.doesNotMatch(JSON.stringify(custody.rows),/Owner@|Operator@|Coordinator@/);
  });
  await t.test('concurrent replay keeps the original Tenant and snapshots with no second email or audit',async()=>{
    const before=await counts(),outcomes=await Promise.all([service().createTenant(input),service().createTenant(input)]);
    for (const result of outcomes) assert.deepEqual(result,{ ...created,outcome: 'idempotent' });
    assert.deepEqual(await counts(),before);
    await assert.rejects(service().createTenant({ ...input,invitations: [] }),/CONFLICT/);assert.deepEqual(await counts(),before);
  });
  await t.test('later audit failure and enclosing proof failure roll back Tenant, mailboxes, invitations, delivery and receipts',async()=>{
    let appends=0;
    const broken=createPostgresPlatformCustomerOnboardingRepository(pool,{ ...configuration,platformAuditRepository: {
      async appendWithClient(...args) { if (++appends===3) throw new Error('SYNTHETIC_AUDIT_FAILED');
        return platformAuditRepository.appendWithClient(...args); },
    } });
    const before=await counts();
    await assert.rejects(service(broken).createTenant({ ...input,idempotencyKey: randomUUID() }),/SYNTHETIC_AUDIT_FAILED/);
    assert.deepEqual(await counts(),before);
    await assert.rejects(withPostgresTransaction(pool,async()=>{ await service().createTenant({ ...input,idempotencyKey: randomUUID() });
      throw new Error('SYNTHETIC_PROOF_ROTATION_FAILED'); },{ isolationLevel: 'REPEATABLE READ' }),/SYNTHETIC_PROOF_ROTATION_FAILED/);
    assert.deepEqual(await counts(),before);
  });
  await t.test('invited directory observes owner email admission while Microsoft directory identity stays independent',async()=>{
    const { directoryReader }=createPostgresPlatformTenantOperationsRepository(pool,{ ...configuration,
      onboardingRepository: createPostgresTenantOnboardingRepository(pool,{ auditRepository: tenantAuditRepository }),
      tenantLifecycleRepository: createPostgresTenantRepository(pool,{ auditRepository: tenantAuditRepository }),
      cursorSecret: 'd'.repeat(48),customerInvitationEnvironment: 'int' });
    const authorization=await authorizePlatformOperation({ authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy,
      operatorContext: issued.principal,operation: PLATFORM_OPERATION.TENANT_DIRECTORY_READ,fleet: true });
    async function current() {
      const result=await directoryReader.list({ authorization,query: { cursor: null,limit: 100,lifecycleStatus: null,search: null } });
      const row=result.items.find(value=>value.tenantId===created.tenant.id);assert.ok(row);
      assert.doesNotMatch(JSON.stringify(result),/Owner@|Operator@|recipient|mailbox|provider_tenant/);return row;
    }
    const initial=await current();assert.equal(initial.onboardingState,'invited');assert.equal(initial.invitationState,'open');
    assert.equal(initial.identityState,'pending');
    const flowBinding=createCustomerEmailFlowBinding({ environment: 'int',secret: 'f'.repeat(48) });
    t.after(()=>flowBinding.destroy());
    const proofFactory=createEmailMailboxProofFactory({ environment: 'int',secret: 'q'.repeat(48),codeFactory: ()=>'00001234' });
    const challenges=createPostgresCustomerEmailChallengeRepository(pool,{ ...configuration,flowBinding,proofFactory });
    const customerSessions=createSessionService({
      repository: createPostgresSessionRepository(pool,{ auditRepository: tenantAuditRepository }),auditService: tenantAuditService,
      publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
    const admission=createCustomerEmailAdmissionService({ auditService: tenantAuditService,sessionService: customerSessions,
      repository: createPostgresCustomerEmailAdmissionRepository(pool,{ environment: 'int',flowBinding,
        auditRepository: tenantAuditRepository }) });
    const sourceKey='b'.repeat(64),started=await challenges.request({ recipient: 'Owner@example.test',locale: 'de',sourceKey });
    const proof=await challenges.verify({ ...started,code: '00001234',sourceKey });assert.equal(proof.status,'membership_required');
    const choices=await admission.choices(proof);assert.equal(choices.items.length,1);
    const accepted=await admission.select({ ...proof,correlationId: randomUUID() },{ membershipId: choices.items[0].membershipId });
    assert.equal(accepted.status,'authenticated');
    const principal=await customerSessions.resolvePrincipal({ headers: { cookie: accepted.setCookie.split(';')[0] } });
    assert.equal(principal.tenantId,created.tenant.id);assert.deepEqual(principal.roles,['employee','tenant_admin']);
    const observed=await current();assert.equal(observed.onboardingState,'claimed');assert.equal(observed.identityState,'pending');
    assert.equal(observed.invitationState,'open'); // Other individual invitations still await acceptance.
    assert.equal((await pool.query('SELECT count(*)::int n FROM tenant_onboarding_invitations')).rows[0].n,0);
    assert.equal(await tenantAuditRepository.verifyTenantChain(created.tenant.id),true);
  });
  const administration=createPlatformCustomerInvitationAdministrationService({
    repository: createPostgresPlatformCustomerInvitationRepository(pool,configuration),platformAuthorizationPolicy,
    tenantTargetPolicy,operationEvidenceFactory,invitationContract,environment: 'int' });
  function command(operation,extra={}) {
    return { operatorContext: issued.principal,tenantId: created.tenant.id,correlationId: randomUUID(),
      idempotencyKey: randomUUID(),reason: input.reason,
      confirmation: { action: operation,tenantId: created.tenant.id },...extra };
  }
  await t.test('real Platform list, extra batch, cross-Tenant object denial and concurrent revoke use the shared custody',async()=>{
    const list={ operatorContext: issued.principal,tenantId: created.tenant.id,correlationId: randomUUID(),
      limit: 100,afterInvitationId: null };
    assert.equal((await administration.list(list)).items.length,3);
    const batch=command(PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [
      { recipient: 'Additional@example.test',roles: ['tenant_admin'],locale: 'en' }] });
    const extra=await administration.issueBatch(batch);assert.equal(extra.invitations.length,1);
    const before=await counts();assert.deepEqual(await administration.issueBatch(batch),{ ...extra,outcome: 'idempotent' });
    assert.deepEqual(await counts(),before);
    const invitationId=extra.invitations[0].id;
    await assert.rejects(administration.reissue(command(PLATFORM_OPERATION.INVITATION_REISSUE,
      { invitationId,expectedRevision: 1 })),/CONFLICT/);
    const foreign=randomUUID();
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Other pilot','onboarding')",[foreign]);
    const denial=command(PLATFORM_OPERATION.INVITATION_REVOKE,{ tenantId: foreign,invitationId,expectedRevision: 1,
      confirmation: { action: PLATFORM_OPERATION.INVITATION_REVOKE,tenantId: foreign } });
    await assert.rejects(administration.revoke(denial),/DENIED/);
    await pool.query(`UPDATE customer_access_deliveries SET status='accepted',attempt_count=1,
      provider_message_id=$2,accepted_at=clock_timestamp() WHERE environment='int' AND invitation_id=$1`,[invitationId,randomUUID()]);
    const revoke=command(PLATFORM_OPERATION.INVITATION_REVOKE,{ invitationId,expectedRevision: 1 });
    const outcomes=await Promise.allSettled([administration.revoke(revoke),
      administration.revoke({ ...revoke,idempotencyKey: randomUUID() })]);
    assert.equal(outcomes.filter(value=>value.status==='fulfilled').length,1);
    const revoked=outcomes.find(value=>value.status==='fulfilled').value;
    assert.equal(revoked.invitation.revision,2);assert.equal(revoked.invitation.delivery,'accepted');
    const facts=await pool.query("SELECT status,provider_message_id FROM customer_access_deliveries WHERE invitation_id=$1",[invitationId]);
    assert.equal(facts.rows[0].status,'accepted');assert.ok(facts.rows[0].provider_message_id);
    assert.equal((await administration.list(list)).items.find(row=>row.id===invitationId).state,'revoked');
    assert.equal(await tenantAuditRepository.verifyTenantChain(created.tenant.id),true);
  });
  await t.test('a legitimate aged initial invitation reissues once with unchanged intent and a fresh delivery revision',async()=>{
    // Historical initial fixture, inserted through the normal immutable custody
    // and audit guards. No clock patch, update bypass, sleep or existing-row edit.
    const tenantId=randomUUID(),correlationId=randomUUID();let historical;
    const authorization=await authorizePlatformOperation({ authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy,
      operatorContext: issued.principal,operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,tenantCreation: true });
    await withPostgresTransaction(pool,async client=>{
      const instant=(await client.query("SELECT clock_timestamp()-interval '61 seconds' AS now")).rows[0].now;
      await client.query(`INSERT INTO tenants(id,display_name,status,created_at,updated_at)
        VALUES($1,'Historical synthetic fixture','onboarding',$2,$2)`,[tenantId,new Date(instant.getTime()-1000)]);
      const custody=createCustomerInvitationCustody(pool,configuration);
      historical=await custody.issue(client,{ tenantId,tenantDisplayName: 'Historical synthetic fixture',now: instant,
        intent: { recipient: 'Resend@example.test',roles: ['conference_manager'],locale: 'de' },
        recordAudit: async({ invitationId })=>{
          const events=await operationEvidenceFactory.createMutation({ authorization,
            operation: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,tenantId,correlationId,reason: input.reason,
            target: { type: 'customer_invitation',id: invitationId },previousState: null,
            requestedState: { revision: 1,status: 'issued' },occurredAt: instant.toISOString() });
          return (await appendPlatformMutationEvidence(client,events,tenantId,configuration)).id;
        } });
    });
    const resend=command(PLATFORM_OPERATION.INVITATION_REISSUE,{ tenantId,invitationId: historical.id,expectedRevision: 1,
      confirmation: { action: PLATFORM_OPERATION.INVITATION_REISSUE,tenantId } });
    const result=await administration.reissue(resend);assert.equal(result.invitation.revision,2);
    assert.equal(result.invitation.recipient,historical.recipient);assert.deepEqual(result.invitation.roles,historical.roles);
    assert.equal(result.invitation.locale,historical.locale);assert.equal(result.invitation.delivery,'queued');
    const deliveries=await pool.query(`SELECT id,invitation_revision,status FROM customer_access_deliveries
      WHERE environment='int' AND tenant_id=$1 AND invitation_id=$2 ORDER BY invitation_revision`,[tenantId,historical.id]);
    assert.deepEqual(deliveries.rows.map(row=>[Number(row.invitation_revision),row.status]),[[1,'cancelled'],[2,'queued']]);
    assert.notEqual(deliveries.rows[0].id,deliveries.rows[1].id);
    const before=await counts();assert.deepEqual(await administration.reissue(resend),{ ...result,outcome: 'idempotent' });
    assert.deepEqual(await counts(),before);assert.equal(await tenantAuditRepository.verifyTenantChain(tenantId),true);
  });
  await t.test('revoked live authority is checked before immutable receipt disclosure or fresh Tenant creation',async()=>{
    await pool.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[issued.principal.session.id]);
    const before=await counts();await assert.rejects(service().createTenant(input),/CREATION_DENIED/);
    await assert.rejects(service().createTenant({ ...input,idempotencyKey: randomUUID() }),/CREATION_DENIED/);
    assert.deepEqual(await counts(),before);
  });
});
