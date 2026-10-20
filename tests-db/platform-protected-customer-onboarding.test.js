import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedPlatformCustomerOnboardingRepository }
  from '../src/persistence/postgres/platform-protected-customer-onboarding-repository.js';
import { createPostgresPlatformCustomerOnboardingRepository } from '../src/persistence/postgres/platform-customer-onboarding-repository.js';
import { createPostgresPlatformOperatorRepository } from '../src/persistence/postgres/platform-operator-repository.js';
import { createPlatformTenantTargetPolicy } from '../src/platform/identity/tenant-target-policy.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPlatformCustomerOnboardingService } from '../src/platform/application/customer-onboarding-service.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createPlatformAuditService } from '../src/platform/audit/audit-service.js';
import { createPlatformOperationEvidenceFactory } from '../src/persistence/postgres/platform-operations-evidence.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { normalizeCustomerInvitationBatch,normalizeCustomerInvitationIntent } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';
import { createProtectedSyntheticOperatorFixture } from './support/protected-synthetic-operator-fixture.js';

test('native protected real onboarding registers immutable REAL custody in the exact shared-lease proof transaction',async t=>{
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
  const repository=createPostgresProtectedPlatformCustomerOnboardingRepository(pool,configuration);
  function application(repo=repository) {
    return createPlatformCustomerOnboardingService({ repository: repo,platformAuthorizationPolicy,tenantTargetPolicy,
      operationEvidenceFactory,environment: 'int',ownerRecipient: 'Owner@example.test',idFactory: randomUUID,
      invitationContract: { normalizeIntent: normalizeCustomerInvitationIntent,normalizeBatch: normalizeCustomerInvitationBatch,
        projectInvitations: projectCustomerInvitations } });
  }
  function intent(name='Protected real pilot') {
    return { displayName: name,reason: 'Synthetic isolated protected acceptance',idempotencyKey: randomUUID(),
      confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,displayName: name },
      invitations: [{ recipient: 'Operator@example.test',roles: ['tenant_admin'],locale: 'en' }] };
  }
  async function execute(value,service=application(),before=async()=>{},actor=owner) {
    const hash=createHash('sha256').update(JSON.stringify({ environment: 'int',securityEpoch: epoch,...value })).digest('hex');
    return actor.execute(hash,async context=>{
      const operatorContext=actor.auth.verifiedOperationPrincipal(context,hash);
      await before();return service.createTenant({ ...value,operatorContext,correlationId: randomUUID() });
    });
  }
  const counts=async()=>(await pool.query(`SELECT
    (SELECT count(*)::int FROM tenants) AS tenants,(SELECT count(*)::int FROM tenant_runtime_registry) AS registry,
    (SELECT count(*)::int FROM customer_access_mailboxes) AS mailboxes,
    (SELECT count(*)::int FROM customer_member_invitations) AS invitations,
    (SELECT count(*)::int FROM customer_access_deliveries) AS deliveries,
    (SELECT count(*)::int FROM platform_operation_receipts) AS receipts,
    (SELECT count(*)::int FROM audit_events) AS audit,
    (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM sessions) AS sessions`)).rows[0];
  const value=intent(),created=await execute(value);
  assert.deepEqual((await pool.query(`SELECT environment,mode,generation_id,operator_id,slot
    FROM tenant_runtime_registry WHERE tenant_id=$1`,[created.tenant.id])).rows,
  [{ environment: 'int',mode: 'real',generation_id: null,operator_id: null,slot: null }]);
  assert.deepEqual(created.invitations.map(row=>row.recipient),['Operator@example.test','Owner@example.test']);
  const after=await counts();assert.equal(after.users,0);assert.equal(after.sessions,0);assert.equal(after.deliveries,2);
  assert.deepEqual(await execute(value),{ ...created,outcome: 'idempotent' });assert.deepEqual(await counts(),after);
  assert.equal(await tenantAuditRepository.verifyTenantChain(created.tenant.id),true);

  await pool.query(`CREATE FUNCTION synthetic_real_registration_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.mode='real' AND current_setting('conference_manager.synthetic_registration_failure',true)='on' THEN
      RAISE EXCEPTION 'SYNTHETIC_REAL_CLASSIFICATION_FAILED'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER synthetic_real_registration_failure BEFORE INSERT ON tenant_runtime_registry
    FOR EACH ROW EXECUTE FUNCTION synthetic_real_registration_failure()`);
  await assert.rejects(execute(intent('Atomic registry rollback'),application(),()=>withPostgresTransaction(pool,
    client=>client.query("SELECT set_config('conference_manager.synthetic_registration_failure','on',true)"),
    { isolationLevel: 'REPEATABLE READ' })),/SYNTHETIC_REAL_CLASSIFICATION_FAILED/);
  assert.deepEqual(await counts(),after);

  const legacyIntent=intent('Unclassified legacy command');
  const legacy=await execute(legacyIntent,application(createPostgresPlatformCustomerOnboardingRepository(pool,configuration)));
  const beforeReplay=await counts();assert.equal(beforeReplay.registry,1);
  await assert.rejects(execute(legacyIntent),/PROTECTED_CUSTOMER_ONBOARDING_CLASSIFICATION_REQUIRED/);
  assert.deepEqual(await counts(),beforeReplay);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM tenant_runtime_registry WHERE tenant_id=$1',
    [legacy.tenant.id])).rows[0].count,0);
  const foreignActor=await createProtectedSyntheticOperatorFixture(pool,leasePool,
    { epoch,scopeMode: 'all',mutationScope: 'shared' });
  for (const patch of [{ environment: 'dev' },{ environment: 'prod' },{ securityEpoch: randomUUID() }]) {
    const foreign=createPostgresProtectedPlatformCustomerOnboardingRepository(pool,{ ...configuration,...patch });
    await assert.rejects(execute(intent(),application(foreign),async()=>{},foreignActor),/PROTECTED_SHARED_EXECUTION_REQUIRED/);
    assert.deepEqual(await counts(),beforeReplay);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM synthetic_tenant_generations')).rows[0].count,0);
});
