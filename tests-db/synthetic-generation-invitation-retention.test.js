import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { createPostgresProtectedInvitedTenantScope } from '../src/persistence/postgres/protected-invited-tenant-scope.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';

test('Microsoft exact-proof replacement preserves invited participants and permits an unrelated empty generation reset',async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const tenantAuditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  async function owner(syntheticParticipantsEnabled=false) {
    const operator=await createProtectedSyntheticMicrosoftFixture(pool,leasePool,{ epoch });
    const application=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
      passkeyService: operator.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
      repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
        assuranceMode: 'microsoft_mfa',syntheticParticipantsEnabled,
        tenantAuditRepository,platformAuditRepository: operator.auditRepository }) });
    return { operator,application };
  }
  function replace({ operator,application },previous=null) {
    const intent={ operatorId: operator.operatorId,expectedGenerationId: previous?.generationId ?? null,
      expectedRevision: previous?.revision ?? 0 };
    return operator.execute(application.operationHash(intent),proofContext=>application.replace({
      proofContext,intent,correlationId: randomUUID() }));
  }
  const pendingOwner=await owner(),acceptedOwner=await owner(true),emptyOwner=await owner(),registeredOwner=await owner(true);
  const pendingGeneration=await replace(pendingOwner),acceptedGeneration=await replace(acceptedOwner);
  const emptyGeneration=await replace(emptyOwner);
  const registeredGeneration=await replace(registeredOwner),registered=[];
  for (const target of registeredGeneration.tenants) {
    const fixture=await createInvitedCustomerFixture(pool,t,{ recipient: `${target.slot}@example.test`,
      targetTenantId: target.tenantId,accept: target.slot!=='northwind',
      async beforeAdmission({ tenantId,invitation }) {
        await pool.query(`INSERT INTO synthetic_invited_memberships
          (environment,tenant_id,membership_id,invitation_id,generation_id,operator_id,slot)
          SELECT 'int',$1,membership_id,id,$3,$4,$5 FROM customer_member_invitations
          WHERE environment='int' AND tenant_id=$1 AND id=$2`,
        [tenantId,invitation.id,registeredGeneration.generationId,registeredOwner.operator.operatorId,target.slot]);
      } });
    registered.push({ ...fixture,slot: target.slot });
  }
  const disabled=registered.find(row=>row.slot==='fabrikam');
  await pool.query('UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',[disabled.tenantId,disabled.principal.userId]);
  const pendingRegistered=registered.find(row=>row.slot==='northwind');
  await pendingRegistered.invitations.revoke({ ...pendingRegistered.context,correlationId: randomUUID() },
    { invitationId: pendingRegistered.invitation.id,expectedRevision: pendingRegistered.invitation.revision });
  const participantScope=createPostgresProtectedInvitedTenantScope(pool,
    { environment: 'int',securityEpoch: epoch,syntheticParticipantsEnabled: true });
  const bindings=(await pool.query('SELECT * FROM synthetic_invited_memberships ORDER BY tenant_id')).rows;
  const qualified=binding=>registeredOwner.operator.scopes.withShared(()=>withPostgresTransaction(pool,
    client=>participantScope.allowsWithClient(client,binding.tenant_id,{ membershipId: binding.membership_id })));
  for (const binding of bindings) assert.equal(await qualified(binding),true);
  // Exercise canonical encrypted invitation/admission custody in isolation. The
  // ordinary base fixture does not enable protected Demo invitation eligibility,
  // send provider mail or attach a mailbox to a seeded delegation persona.
  const pending=await createInvitedCustomerFixture(pool,t,{ targetTenantId: pendingGeneration.tenants[2].tenantId,accept: false });
  const accepted=await createInvitedCustomerFixture(pool,t,{ targetTenantId: acceptedGeneration.tenants[0].tenantId });
  assert.equal(accepted.principal.tenantId,accepted.tenantId);
  assert.equal((await pool.query('SELECT accepted_at FROM customer_member_invitations WHERE tenant_id=$1 AND id=$2',
    [pending.tenantId,pending.invitation.id])).rows[0].accepted_at,null);
  assert.ok(await accepted.sessions.resolvePrincipal({ headers: { cookie: accepted.cookie } }));
  const realControl=await createInvitedCustomerFixture(pool,t,{ recipient: 'RealControl@example.test' });
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[realControl.tenantId]);
  async function retainedReal() {
    return (await pool.query(`SELECT jsonb_build_object(
      'tenant',(SELECT to_jsonb(t) FROM tenants t WHERE id=$1),
      'registry',(SELECT to_jsonb(r) FROM tenant_runtime_registry r WHERE tenant_id=$1),
      'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM users u WHERE tenant_id=$1),
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id,role) FROM tenant_user_roles r WHERE tenant_id=$1),
      'identities',(SELECT jsonb_agg(to_jsonb(b) ORDER BY provider,provider_user_reference)
        FROM user_identity_bindings b WHERE tenant_id=$1),
      'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s WHERE tenant_id=$1),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_memberships m WHERE tenant_id=$1),
      'invitations',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM customer_member_invitations i WHERE tenant_id=$1),
      'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_events a WHERE tenant_id=$1)
      ) AS state`,[realControl.tenantId])).rows[0].state;
  }
  const realBefore=await retainedReal();
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
      'platformTenantAudit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY sequence)
        FROM platform_audit_events a WHERE target_tenant_id IS NOT NULL)
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
  const registeredDefault={ operator: registeredOwner.operator,
    application: createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
      passkeyService: registeredOwner.operator.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
      repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
        assuranceMode: 'microsoft_mfa',tenantAuditRepository,
        platformAuditRepository: registeredOwner.operator.auditRepository }) }) };
  await blocked(registeredDefault,registeredGeneration);
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
  async function retainedPeople() {
    return (await pool.query(`SELECT jsonb_build_object(
      'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY tenant_id,id) FROM users u WHERE tenant_id=ANY($1::uuid[])),
      'roles',(SELECT jsonb_agg(to_jsonb(r) ORDER BY tenant_id,user_id,role) FROM tenant_user_roles r WHERE tenant_id=ANY($1::uuid[])),
      'identities',(SELECT jsonb_agg(to_jsonb(b) ORDER BY tenant_id,provider,provider_user_reference)
        FROM user_identity_bindings b WHERE tenant_id=ANY($1::uuid[])),
      'sessions',(SELECT jsonb_agg(to_jsonb(s)-'revoked_at' ORDER BY id) FROM sessions s WHERE tenant_id=ANY($1::uuid[])),
      'memberships',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_memberships m WHERE tenant_id=ANY($1::uuid[])),
      'invitations',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM customer_member_invitations i WHERE tenant_id=ANY($1::uuid[])),
      'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY tenant_id,membership_id)
        FROM synthetic_invited_memberships b WHERE tenant_id=ANY($1::uuid[])),
      'mailboxes',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM customer_access_mailboxes m)
      ) AS state`,[registeredGeneration.tenants.map(row=>row.tenantId)])).rows[0].state;
  }
  const people=await retainedPeople();
  const beforeAuditFailure=await state();
  const failing={ operator: registeredOwner.operator,
    application: createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
      passkeyService: registeredOwner.operator.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
      repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
        assuranceMode: 'microsoft_mfa',syntheticParticipantsEnabled: true,
        tenantAuditRepository: { async appendWithClient() { throw new Error('ISOLATED_REPLACEMENT_AUDIT_FAILURE'); } },
        platformAuditRepository: registeredOwner.operator.auditRepository }) }) };
  await assert.rejects(replace(failing,registeredGeneration),/ISOLATED_REPLACEMENT_AUDIT_FAILURE/);
  assert.deepEqual(await state(),beforeAuditFailure);
  for (const binding of bindings) assert.equal(await qualified(binding),true);
  const replacement=await replace(registeredOwner,registeredGeneration);
  assert.deepEqual(await retainedPeople(),people);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sessions
    WHERE tenant_id=ANY($1::uuid[]) AND revoked_at IS NULL`,[registeredGeneration.tenants.map(row=>row.tenantId)])).rows[0].n,0);
  for (const row of registered.filter(row=>row.sessions)) {
    assert.equal(await row.sessions.resolvePrincipal({ headers: { cookie: row.cookie } }),null);
  }
  assert.equal((await pool.query('SELECT state FROM synthetic_tenant_generations WHERE id=$1',
    [registeredGeneration.generationId])).rows[0].state,'archived');
  for (const binding of bindings) assert.equal(await qualified(binding),false);
  for (const old of registeredGeneration.tenants) {
    assert.equal((await pool.query('SELECT status FROM tenants WHERE id=$1',[old.tenantId])).rows[0].status,'archived');
    assert.ok(replacement.tenants.every(row=>row.tenantId!==old.tenantId));
    assert.equal(await tenantAuditRepository.verifyTenantChain(old.tenantId),true);
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM customer_access_memberships
    WHERE tenant_id=ANY($1::uuid[])`,[replacement.tenants.map(row=>row.tenantId)])).rows[0].n,0);
  assert.deepEqual(await retainedReal(),realBefore);
  assert.ok(await realControl.sessions.resolvePrincipal({ headers: { cookie: realControl.cookie } }));
  // Fresh explicit invitations on the newly allocated Tenants are required.
  // Reuse the real mailbox while preserving its old Tenant's disabled/history
  // state; no identity, roles or membership is transferred automatically.
  const cooldown=(await pool.query(`SELECT GREATEST(0,COALESCE(MAX(EXTRACT(EPOCH FROM
    (last_issued_at+interval '60 seconds'-clock_timestamp()))*1000),0)) AS remaining
    FROM customer_access_abuse_budgets WHERE environment='int' AND kind='recipient'`)).rows[0];
  const remaining=Number(cooldown.remaining);assert.ok(Number.isFinite(remaining) && remaining>=0 && remaining<=60000);
  if (remaining>0) await delay(Math.ceil(remaining)+50);
  const fresh=[];
  for (const target of replacement.tenants) {
    const invited=await createInvitedCustomerFixture(pool,t,{ recipient: `${target.slot}@example.test`,targetTenantId: target.tenantId,
      async beforeAdmission({ invitation }) {
        await pool.query(`INSERT INTO synthetic_invited_memberships
          (environment,tenant_id,membership_id,invitation_id,generation_id,operator_id,slot)
          SELECT 'int',$1,membership_id,id,$3,$4,$5 FROM customer_member_invitations
          WHERE environment='int' AND tenant_id=$1 AND id=$2`,
        [target.tenantId,invitation.id,replacement.generationId,registeredOwner.operator.operatorId,target.slot]);
      } });
    const previous=registered.find(row=>row.slot===target.slot);
    if (previous.principal) assert.notEqual(invited.principal.userId,previous.principal.userId);
    fresh.push(invited);
  }
  assert.deepEqual(await retainedPeople(),people);
  const freshBindings=(await pool.query(`SELECT * FROM synthetic_invited_memberships
    WHERE generation_id=$1 ORDER BY tenant_id`,[replacement.generationId])).rows;
  assert.equal(freshBindings.length,3);
  for (const binding of freshBindings) assert.equal(await qualified(binding),true);
  await delay(10_100);
  const secondReplacement=await replace(registeredOwner,replacement);
  assert.deepEqual(await retainedPeople(),people);assert.deepEqual(await retainedReal(),realBefore);
  for (const binding of [...bindings,...freshBindings]) assert.equal(await qualified(binding),false);
  for (const invited of fresh) {
    assert.equal(await invited.sessions.resolvePrincipal({ headers: { cookie: invited.cookie } }),null);
    assert.equal(await tenantAuditRepository.verifyTenantChain(invited.tenantId),true);
  }
  assert.ok(await realControl.sessions.resolvePrincipal({ headers: { cookie: realControl.cookie } }));
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM customer_access_memberships
    WHERE tenant_id=ANY($1::uuid[])`,[secondReplacement.tenants.map(row=>row.tenantId)])).rows[0].n,0);
  assert.ok(secondReplacement.tenants.every(row=>!replacement.tenants.some(old=>old.tenantId===row.tenantId)));
  for (const generation of [pendingGeneration,acceptedGeneration]) {
    const retained=(await pool.query('SELECT state FROM synthetic_tenant_generations WHERE id=$1',[generation.generationId])).rows[0];
    assert.equal(retained.state,'active');
    for (const tenant of generation.tenants) assert.equal(await tenantAuditRepository.verifyTenantChain(tenant.tenantId),true);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials')).rows[0].n,0);
});
