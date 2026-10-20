import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedPlatformCustomerInvitationRepository }
  from '../src/persistence/postgres/platform-protected-customer-invitation-repository.js';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformOperationEvidenceFactory } from '../src/persistence/postgres/platform-operations-evidence.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { normalizeCustomerInvitationBatch } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

import { createPlatformCustomerInvitationAdministrationService }
  from '../src/platform/application/customer-invitation-administration-service.js';
test('native protected Platform invitation administration preserves exact proof, REAL scope, receipts and both audit domains',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const owner=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch,scopeMode: 'all',mutationScope: 'shared' });
  const tenantAuditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 't'.repeat(48) });
  const platformAuthorizationPolicy=createPlatformAuthorizationPolicy();
  const tenantTargetPolicy=createPlatformTenantTargetPolicy({ operatorRepository: createPostgresPlatformOperatorRepository(pool,
    { auditRepository: owner.auditRepository }) });
  const tenantAuditService=createAuditService({ repository: tenantAuditRepository,authorizationPolicy: createAuthorizationPolicy() });
  const platformAuditService=createPlatformAuditService({ repository: owner.auditRepository,
    authorizationPolicy: platformAuthorizationPolicy,tenantTargetPolicy });
  const operationEvidenceFactory=createPlatformOperationEvidenceFactory({ tenantAuditService,platformAuditService });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const configuration={ environment: 'int',securityEpoch: epoch,cipher,
    content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' }),
    tenantAuditRepository,platformAuditRepository: owner.auditRepository };
  const repository=createPostgresProtectedPlatformCustomerInvitationRepository(pool,configuration);
  const service=createPlatformCustomerInvitationAdministrationService({ repository,platformAuthorizationPolicy,tenantTargetPolicy,
    operationEvidenceFactory,environment: 'int',invitationContract: {
      normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations } });
  const real=randomUUID(),unclassified=randomUUID(),synthetic=randomUUID(),generationId=randomUUID();
  for (const id of [real,unclassified,synthetic]) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic invitation target','onboarding')",[id]);
  }
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real]);
  await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
    VALUES('int',$1,$2,1,$3)`,[generationId,owner.operatorId,epoch]);
  for (const [index,slot] of ['northwind','contoso','fabrikam'].entries()) {
    const id=index===0 ? synthetic : randomUUID();
    if (index!==0) await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic slot','onboarding')",[id]);
    await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
      VALUES('int',$1,'synthetic',$2,$3,$4)`,[id,generationId,owner.operatorId,slot]);
  }
  await pool.query("UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp() WHERE id=$1",
    [generationId]);
  const counts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM customer_access_mailboxes) AS mailboxes,
    (SELECT count(*)::int FROM customer_member_invitations) AS invitations,
    (SELECT count(*)::int FROM customer_access_deliveries) AS deliveries,
    (SELECT count(*)::int FROM platform_operation_receipts) AS receipts,
    (SELECT count(*)::int FROM audit_events) AS audits,
    (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM sessions) AS sessions`)).rows[0];
  function command(tenantId,operation,extra={}) {
    return { tenantId,reason: 'Synthetic isolated mode acceptance',correlationId: randomUUID(),idempotencyKey: randomUUID(),
      confirmation: { tenantId,action: operation },...extra };
  }
  async function execute(actor,method,value) {
    const hash=createHash('sha256').update(JSON.stringify({ environment: 'int',securityEpoch: epoch,method,...value })).digest('hex');
    return actor.execute(hash,context=>service[method]({ ...value,operatorContext: actor.auth.verifiedOperationPrincipal(context,hash) }));
  }
  const batch=command(real,PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [
    { recipient: 'First@example.test',roles: ['tenant_admin'],locale: 'de' },
    { recipient: 'Second@example.test',roles: ['conference_manager'],locale: 'en' }] });
  const created=await execute(owner,'issueBatch',batch);assert.equal(created.invitations.length,2);
  const afterCreate=await counts();assert.equal(afterCreate.users,0);assert.equal(afterCreate.sessions,0);
  assert.deepEqual(await execute(owner,'issueBatch',batch),{ ...created,outcome: 'idempotent' });
  assert.deepEqual(await counts(),afterCreate);
  const invitationId=created.invitations[0].id;
  await assert.rejects(execute(owner,'reissue',command(real,PLATFORM_OPERATION.INVITATION_REISSUE,
    { invitationId,expectedRevision: 1 })),/CONFLICT/); // Existing 60-second cooldown is unchanged.
  const revoked=await execute(owner,'revoke',command(real,PLATFORM_OPERATION.INVITATION_REVOKE,
    { invitationId,expectedRevision: 1 }));
  assert.equal(revoked.invitation.state,'revoked');assert.equal(revoked.invitation.revision,2);
  async function list(actor,tenantId) {
    return execute(actor,'list',{ tenantId,correlationId: randomUUID(),limit: 100,afterInvitationId: null });
  }
  assert.equal((await list(owner,real)).items.length,2);
  // Independent negative scenarios own real signed test keys; retained proof
  // rows and the production cap5 are never cleared, expired or increased.
  const other=await createProtectedSyntheticOperatorFixture(pool,leasePool,{ epoch,scopeMode: 'all',mutationScope: 'shared' });
  for (const tenantId of [unclassified,synthetic]) {
    const before=await counts();
    await assert.rejects(execute(other,'issueBatch',command(tenantId,PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [
      { recipient: 'Denied@example.test',roles: ['tenant_admin'],locale: 'de' }] })),/DENIED/);
    await assert.rejects(list(other,tenantId),/DENIED/);assert.deepEqual(await counts(),before);
  }
  assert.equal(await tenantAuditRepository.verifyTenantChain(real),true);
  const observed=await counts();assert.equal(observed.users,0);assert.equal(observed.sessions,0);
});
