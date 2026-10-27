import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';

test('Microsoft exact-proof replacement preserves invited participants and permits an unrelated empty generation reset',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const tenantAuditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  async function owner() {
    const operator=await createProtectedSyntheticMicrosoftFixture(pool,leasePool,{ epoch });
    const application=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
      passkeyService: operator.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
      repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
        assuranceMode: 'microsoft_mfa',tenantAuditRepository,platformAuditRepository: operator.auditRepository }) });
    return { operator,application };
  }
  function replace({ operator,application },previous=null) {
    const intent={ operatorId: operator.operatorId,expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 };
    return operator.execute(application.operationHash(intent),proofContext=>application.replace({
      proofContext,intent,correlationId: randomUUID() }));
  }
  const pendingOwner=await owner(),acceptedOwner=await owner(),emptyOwner=await owner();
  const pendingGeneration=await replace(pendingOwner),acceptedGeneration=await replace(acceptedOwner);
  const emptyGeneration=await replace(emptyOwner);
  // Exercise canonical encrypted invitation/admission custody in isolation. The
  // ordinary base fixture does not enable protected Demo invitation eligibility,
  // send provider mail or attach a mailbox to a seeded delegation persona.
  const pending=await createInvitedCustomerFixture(pool,t,{ targetTenantId: pendingGeneration.tenants[2].tenantId,accept: false });
  const accepted=await createInvitedCustomerFixture(pool,t,{ targetTenantId: acceptedGeneration.tenants[0].tenantId });
  assert.ok(await accepted.sessions.resolvePrincipal({ headers: { cookie: accepted.cookie } }));
  async function state() {
    return (await pool.query(`SELECT jsonb_build_object(
      'tenants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenants t),
      'generations',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM synthetic_tenant_generations g),
      'registry',(SELECT jsonb_agg(to_jsonb(r) ORDER BY tenant_id) FROM tenant_runtime_registry r),
      'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY tenant_id,id) FROM users u),
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY tenant_id,user_id,role) FROM tenant_user_roles r),
      'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY tenant_id,provider,provider_user_reference) FROM user_identity_bindings b),
      'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_memberships m),
      'invitations',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM customer_member_invitations i),
      'deliveries',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM customer_access_deliveries d),
      'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY tenant_id,id) FROM requests r),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tenant_id,id) FROM audit_events a),
      'platformTenantAudit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM platform_audit_events a WHERE target_tenant_id IS NOT NULL)
      ) AS state`)).rows[0].state;
  }
  // Real elapsed production cooldown. No clock rewrites or shortened limits.
  await new Promise(resolve=>setTimeout(resolve,10_100));
  async function blocked(actor,generation) {
    const before=await state(),cookie=actor.operator.current().setCookie.split(';')[0];
    await assert.rejects(replace(actor,generation),/^Error: SYNTHETIC_GENERATION_DENIED$/);
    assert.deepEqual(await state(),before);
    assert.ok(await actor.operator.sessions.resolvePrincipal({ headers: { cookie } }));
  }
  await blocked(pendingOwner,pendingGeneration);
  await blocked(acceptedOwner,acceptedGeneration);
  assert.ok(await accepted.sessions.resolvePrincipal({ headers: { cookie: accepted.cookie } }));
  // Revocation must not make retained pending membership history disposable.
  await pending.invitations.revoke({ ...pending.context,correlationId: randomUUID() },
    { invitationId: pending.invitation.id,expectedRevision: pending.invitation.revision });
  await blocked(pendingOwner,pendingGeneration);
  // Current disablement/security-version changes must not cause original
  // invitation roles or an active User to be recreated by reset.
  await pool.query('UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',[accepted.tenantId,accepted.principal.userId]);
  assert.equal(await accepted.sessions.resolvePrincipal({ headers: { cookie: accepted.cookie } }),null);
  await blocked(acceptedOwner,acceptedGeneration);
  const unblocked=await replace(emptyOwner,emptyGeneration);
  assert.ok(unblocked.tenants.every(row=>!emptyGeneration.tenants.some(old=>old.tenantId===row.tenantId)));
  assert.equal((await pool.query('SELECT state FROM synthetic_tenant_generations WHERE id=$1',
    [emptyGeneration.generationId])).rows[0].state,'archived');
  for (const generation of [pendingGeneration,acceptedGeneration]) {
    const retained=(await pool.query('SELECT state FROM synthetic_tenant_generations WHERE id=$1',[generation.generationId])).rows[0];
    assert.equal(retained.state,'active');
    for (const tenant of generation.tenants) assert.equal(await tenantAuditRepository.verifyTenantChain(tenant.tenantId),true);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials')).rows[0].n,0);
});
