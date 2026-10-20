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
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { normalizeCustomerInvitationBatch,normalizeCustomerInvitationIntent } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';

// An isolated migrated PostgreSQL database, real persisted Platform sessions and
// both real audit repositories. No provider or outbound transport is configured.
test('Platform creates owner-inclusive real customer invitations atomically without Customer impersonation',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const operatorId=randomUUID(),roles=['platform_tenant_operator'];
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,status,scope_mode,roles)
    VALUES($1,'microsoft_entra_platform','synthetic-directory',$3,'active','all',$2)`,[operatorId,roles,operatorId]);
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
  await t.test('revoked live authority is checked before immutable receipt disclosure or fresh Tenant creation',async()=>{
    await pool.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[issued.principal.session.id]);
    const before=await counts();await assert.rejects(service().createTenant(input),/CREATION_DENIED/);
    await assert.rejects(service().createTenant({ ...input,idempotencyKey: randomUUID() }),/CREATION_DENIED/);
    assert.deepEqual(await counts(),before);
  });
});
