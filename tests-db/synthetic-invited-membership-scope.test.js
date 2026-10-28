import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool,isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresProtectedParticipantPlatformInvitationRepository }
  from '../src/persistence/postgres/platform-protected-participant-invitation-repository.js';
import { createPostgresProtectedPlatformCustomerInvitationRepository }
  from '../src/persistence/postgres/platform-protected-customer-invitation-repository.js';
import { createPostgresProtectedSyntheticParticipantScope }
  from '../src/persistence/postgres/protected-synthetic-participant-scope.js';
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
import { createPlatformCustomerInvitationAdministrationService }
  from '../src/platform/application/customer-invitation-administration-service.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';

test('native participant registration retains exact Microsoft proof and member-qualified own-generation custody',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const audit=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const configuration={ environment: 'int',securityEpoch: epoch,cipher,
    content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://127.0.0.1' }),tenantAuditRepository: audit };
  async function actor({ legacy=false }={}) {
    const operator=await createProtectedSyntheticMicrosoftFixture(pool,leasePool,
      { epoch,scopeMode: 'all',executionScope: 'shared' });
    const authorizationPolicy=createPlatformAuthorizationPolicy();
    const tenantTargetPolicy=createPlatformTenantTargetPolicy({ operatorRepository:
      createPostgresPlatformOperatorRepository(pool,{ auditRepository: operator.auditRepository }) });
    const operationEvidenceFactory=createPlatformOperationEvidenceFactory({
      tenantAuditService: createAuditService({ repository: audit,authorizationPolicy: createAuthorizationPolicy() }),
      platformAuditService: createPlatformAuditService({ repository: operator.auditRepository,
        authorizationPolicy,tenantTargetPolicy }),
    });
    const factory=legacy ? createPostgresProtectedPlatformCustomerInvitationRepository
      : createPostgresProtectedParticipantPlatformInvitationRepository;
    const repository=factory(pool,{ ...configuration,platformAuditRepository: operator.auditRepository });
    const service=createPlatformCustomerInvitationAdministrationService({ repository,platformAuthorizationPolicy: authorizationPolicy,
      tenantTargetPolicy,operationEvidenceFactory,environment: 'int',invitationContract: {
        normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations } });
    return { operator,service };
  }
  async function generation(operator) {
    const generationId=randomUUID(),tenants=[];
    await pool.query(`INSERT INTO synthetic_tenant_generations(environment,id,operator_id,operator_security_version,security_epoch)
      VALUES('int',$1,$2,$3,$4)`,[generationId,operator.operatorId,operator.current().principal.securityVersion,epoch]);
    for (const slot of ['northwind','contoso','fabrikam']) {
      const tenantId=randomUUID();
      await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,$2,'onboarding')",[tenantId,slot]);
      await pool.query(`INSERT INTO tenant_runtime_registry(environment,tenant_id,mode,generation_id,operator_id,slot)
        VALUES('int',$1,'synthetic',$2,$3,$4)`,[tenantId,generationId,operator.operatorId,slot]);
      tenants.push({ tenantId,slot });
    }
    await pool.query(`UPDATE synthetic_tenant_generations SET state='active',revision=2,activated_at=clock_timestamp()
      WHERE environment='int' AND id=$1`,[generationId]);
    return { generationId,tenants };
  }
  function execute(actor,method,value) {
    const hash=createHash('sha256').update(JSON.stringify({ environment: 'int',securityEpoch: epoch,method,...value })).digest('hex');
    return actor.operator.execute(hash,context=>actor.service[method]({ ...value,
      operatorContext: actor.operator.auth.verifiedOperationPrincipal(context,hash) }));
  }
  function command(tenantId,recipient) {
    return { tenantId,correlationId: randomUUID(),reason: 'Explicit isolated participant invitation',idempotencyKey: randomUUID(),
      confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,tenantId },
      invitations: [{ recipient,roles: ['tenant_admin'],locale: 'de' }] };
  }
  const owner=await actor(),owned=await generation(owner.operator),issued=[];
  for (const { tenantId,slot } of owned.tenants) {
    const result=await execute(owner,'issueBatch',command(tenantId,`${slot}@example.test`));
    issued.push({ tenantId,slot,invitationId: result.invitations[0].id });
  }
  const bindings=(await pool.query('SELECT * FROM synthetic_invited_memberships ORDER BY slot')).rows;
  assert.equal(bindings.length,3);
  for (const row of bindings) {
    const target=issued.find(item=>item.slot===row.slot);
    assert.equal(row.environment,'int');assert.equal(row.tenant_id,target.tenantId);
    assert.equal(row.invitation_id,target.invitationId);assert.equal(row.generation_id,owned.generationId);
    assert.equal(row.operator_id,owner.operator.operatorId);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_identity_bindings')).rows[0].n,0);
  const scope=createPostgresProtectedSyntheticParticipantScope(pool,{ environment: 'int',securityEpoch: epoch });
  const eligible=(tenantId,member)=>owner.operator.scopes.withShared(()=>withPostgresTransaction(pool,
    client=>scope.allowsWithClient(client,tenantId,member)));
  for (const row of bindings) {
    assert.equal(await eligible(row.tenant_id,{ membershipId: row.membership_id }),true);
    assert.equal(await eligible(row.tenant_id,{ invitationId: row.invitation_id }),true);
    assert.equal(await eligible(row.tenant_id,{ membershipId: randomUUID() }),false);
    assert.equal(await eligible(owned.tenants.find(item=>item.tenantId!==row.tenant_id).tenantId,
      { membershipId: row.membership_id }),false);
  }
  // Canonical unregistered history on the SAME otherwise eligible Tenant cannot
  // acquire the new path merely because another approved member exists there.
  const unregistered=await createInvitedCustomerFixture(pool,t,{ targetTenantId: owned.tenants[2].tenantId,
    recipient: 'Unregistered@example.test',accept: false });
  assert.equal(await eligible(unregistered.tenantId,{ invitationId: unregistered.invitation.id }),false);
  const history=async()=>(await pool.query(`SELECT jsonb_build_object(
    'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_memberships m),
    'invites',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM customer_member_invitations i),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY membership_id) FROM synthetic_invited_memberships b),
    'delivery',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM customer_access_deliveries d),
    'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY idempotency_key) FROM platform_operation_receipts r),
    'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tenant_id,id) FROM audit_events a)) AS value`)).rows[0].value;
  const other=await actor();let before=await history();
  await assert.rejects(execute(other,'issueBatch',command(owned.tenants[0].tenantId,'Foreign@example.test')),/DENIED/);
  assert.deepEqual(await history(),before);
  await assert.rejects(execute(other,'list',{ tenantId: owned.tenants[0].tenantId,
    correlationId: randomUUID(),limit: 100,afterInvitationId: null }),/DENIED/);
  assert.deepEqual(await history(),before);
  const real=randomUUID();
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Real scope fixture','onboarding')",[real]);
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real]);
  await execute(other,'issueBatch',command(real,'Real@example.test'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM synthetic_invited_memberships')).rows[0].n,3);
  const strict=await actor({ legacy: true }),strictGeneration=await generation(strict.operator);
  before=await history();
  await assert.rejects(execute(strict,'issueBatch',command(strictGeneration.tenants[0].tenantId,'Strict@example.test')),/DENIED/);
  assert.deepEqual(await history(),before);
  for (const sql of ['UPDATE synthetic_invited_memberships SET slot=slot','DELETE FROM synthetic_invited_memberships']) {
    await assert.rejects(pool.query(sql),/SYNTHETIC_PARTICIPANT_BINDING_IMMUTABLE/);
  }
  await assert.rejects(pool.query('TRUNCATE synthetic_invited_memberships'),/SYNTHETIC_PARTICIPANT_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  await assert.rejects(rollbackLatest(pool),/SYNTHETIC_PARTICIPANT_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  assert.equal(await isPostgresSchemaReady(pool,73),true);
  for (const { tenantId } of owned.tenants) assert.equal(await audit.verifyTenantChain(tenantId),true);
  // Human membership source custody is independent of a delegated live Owner
  // session, but it cannot survive current owner disablement/security changes.
  await pool.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE operator_id=$1',[owner.operator.operatorId]);
  assert.equal(await eligible(bindings[0].tenant_id,{ membershipId: bindings[0].membership_id }),true);
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operator.operatorId]);
  assert.equal(await eligible(bindings[0].tenant_id,{ membershipId: bindings[0].membership_id }),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials')).rows[0].n,0);
});
