import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresSyntheticOnboardingRepository } from '../src/persistence/postgres/synthetic-onboarding-repository.js';
import { createSyntheticOnboardingService } from '../src/application/synthetic-onboarding-service.js';
import { isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
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

import { createPostgresProtectedParticipantCustomerAccessRepository,createPostgresProtectedCustomerAccessRepository }
  from '../src/persistence/postgres/protected-customer-access-repository.js';
import { createPostgresProtectedParticipantSessionRepository }
  from '../src/persistence/postgres/protected-invited-session-repository.js';
import { createPostgresProtectedInvitedTenantScope } from '../src/persistence/postgres/protected-invited-tenant-scope.js';
import { createPostgresCustomerEmailChallengeRepository } from '../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresCustomerEmailAdmissionRepository } from '../src/persistence/postgres/customer-email-admission-repository.js';
import { createCustomerEmailAdmissionService } from '../src/identity/customer-email-admission-service.js';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';
import { createProtectedInvitedCustomerSessions } from '../src/identity/protected-invited-customer-sessions.js';

import { createPostgresProtectedSyntheticCustomerCustody } from '../src/persistence/postgres/protected-synthetic-customer-custody.js';
import { createPostgresProtectedCatalogueMediaRepository } from '../src/persistence/postgres/protected-catalogue-media-repository.js';
import { createPostgresProtectedCalendarAuthorityGuard } from '../src/persistence/postgres/protected-calendar-authority-guard.js';
import { createSyntheticTemplateMediaSource } from '../src/media/synthetic-template-media.js';
import { createSyntheticBusinessTemplates } from '../src/synthetic/business-templates.js';
import { loadConfig } from '../src/config.js';
import { createProtectedInvitedCustomerAccess } from '../src/protected-invited-customer-access-composition.js';
import { createProtectedCustomerAuthentication } from '../src/protected-customer-authentication-composition.js';
import { createProtectedCustomerAccessDeliveryWorker } from '../src/protected-customer-access-delivery-composition.js';

test('native participant registration retains exact Microsoft proof and member-qualified own-generation custody',async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),pools=[];
  function database(url) {
    const pool=new pg.Pool({ connectionString: url,ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1,
      connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});pools.push(pool);return pool;
  }
  const pool=database(fixture.url.href),leasePool=database(fixture.url.href);
  t.after(async()=>{ try { await Promise.all(pools.map(pool=>pool.end())); } finally { await fixture.destroy(); } });
  await migrateUp(pool);
  const epoch=randomUUID();
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  assert.match(fixture.password,/^[a-f0-9]{64}$/);
  for (const surface of ['customer','platform']) {
    await pool.query(`CREATE ROLE "cm_protected_int_${surface}" LOGIN PASSWORD '${fixture.password}'`);
  }
  await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
  const customerUrl=new URL(fixture.url);customerUrl.username='cm_protected_int_customer';
  const customerPool=database(customerUrl.href),customerLease=database(customerUrl.href);
  const customerScopes=createPostgresProtectedRuntimeExecutionScopes({ pool: customerPool,leasePool: customerLease,
    environment: 'int',securityEpoch: epoch });
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
  // Actual mailbox proof, invitation admission and session/audit commit share
  // the max-one business pool while the independent shared lease stays live.
  const protection={ environment: 'int',securityEpoch: epoch };
  const customerAudit=createPostgresAuditRepository(customerPool,{ hmacSecret: 'a'.repeat(48) });
  const participantAccess=createPostgresProtectedParticipantCustomerAccessRepository(customerPool,protection);
  const strictAccess=createPostgresProtectedCustomerAccessRepository(customerPool,protection);
  const participantScope=createPostgresProtectedInvitedTenantScope(customerPool,{ ...protection,syntheticParticipantsEnabled: true });
  const sessions=createProtectedInvitedCustomerSessions({ ...protection,syntheticParticipantsEnabled: true,
    sessionRepository: createPostgresProtectedParticipantSessionRepository(customerPool,{ ...protection,auditRepository: customerAudit }),
    accessRepository: participantAccess,auditService: createAuditService({ repository: customerAudit,
      authorizationPolicy: createAuthorizationPolicy() }),publicOrigin: 'https://127.0.0.1',csrfSecret: 's'.repeat(48) });
  const flowBinding=createCustomerEmailFlowBinding({ environment: 'int',secret: 'f'.repeat(48) });
  t.after(()=>flowBinding.destroy());
  const proofFactory=createEmailMailboxProofFactory({ environment: 'int',secret: 'p'.repeat(48),codeFactory: ()=> '00001234' });
  const challenges=createPostgresCustomerEmailChallengeRepository(customerPool,{ environment: 'int',cipher,flowBinding,proofFactory,
    content: configuration.content,tenantEligibility: participantScope });
  const admission=createCustomerEmailAdmissionService({ repository: createPostgresCustomerEmailAdmissionRepository(customerPool,
    { environment: 'int',flowBinding,auditRepository: customerAudit,
      tenantEligibility: { allowsWithClient: participantScope.lockAdmissionWithClient } }),
    auditService: createAuditService({ repository: customerAudit,authorizationPolicy: createAuthorizationPolicy() }),
    sessionService: sessions });
  const shared=work=>customerScopes.withShared(work),sourceKey='e'.repeat(64),accepted=[];
  for (const target of issued) {
    const pending=await shared(()=>challenges.request({ recipient: `${target.slot}@example.test`,locale: 'de',sourceKey }));
    const verified=await shared(()=>challenges.verify({ ...pending,code: '00001234',sourceKey }));
    assert.equal(verified.status,'membership_required');
    const choices=await shared(()=>admission.choices(verified));assert.equal(choices.items.length,1);
    const result=await shared(()=>admission.select({ ...verified,correlationId: randomUUID() },
      { membershipId: choices.items[0].membershipId }));
    const request={ headers: { cookie: result.setCookie.split(';')[0] } };
    const principal=await shared(()=>sessions.resolvePrincipal(request));
    assert.equal(principal.tenantId,target.tenantId);assert.equal(principal.providerIdentity.provider,'email_code');
    assert.deepEqual(principal.roles,['employee','tenant_admin']);
    const access=await shared(()=>participantAccess.resolveCurrentAccess({ ...protection,principal }));
    assert.equal(access.kind,'synthetic_participant');assert.equal(access.runtime.generationId,owned.generationId);
    assert.equal(access.runtime.slot,target.slot);
    assert.equal(await strictAccess.resolveCurrentAccess({ ...protection,principal }),null);
    assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': sessions.csrfTokenForPrincipal(principal) } },principal),true);
    assert.equal(await sessions.verifyCsrf({ headers: { 'x-csrf-token': 'invalid' } },principal),false);
    const foreign={ ...principal,tenantId: issued.find(row=>row.tenantId!==target.tenantId).tenantId };
    assert.equal(await shared(()=>participantAccess.resolveCurrentAccess({ ...protection,principal: foreign })),null);
    accepted.push({ request,principal });
  }
  const syntheticScope={ ...protection,platformSecurityEpoch: 7,
    customerOrigin: 'https://app-int.example.test',platformOrigin: 'https://ops-int.example.com' };
  const participantOptions={ ...protection,syntheticScope,syntheticParticipantsEnabled: true };
  const businessCustody=createPostgresProtectedSyntheticCustomerCustody(customerPool,
    { scope: syntheticScope,syntheticParticipantsEnabled: true });
  const mediaRepository=createPostgresProtectedCatalogueMediaRepository(customerPool,participantOptions);
  const calendarGuard=createPostgresProtectedCalendarAuthorityGuard(customerPool,participantOptions);
  await assert.rejects(customerPool.query('UPDATE tenants SET status=status'),{ code: '42501' });
  await assert.rejects(customerPool.query('UPDATE platform_operators SET status=status'),{ code: '42501' });
  await assert.rejects(customerPool.query('INSERT INTO synthetic_invited_memberships DEFAULT VALUES'),{ code: '42501' });
  await assert.rejects(customerPool.query(`SELECT protected_apply_synthetic_lifecycle('int',$1,$2,$3,'onboarding','ready',1)`,
    [epoch,accepted[0].principal.tenantId,owned.generationId]),{ code: '42501' });
  for (const [signature,definer] of [
    ['protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint)',true],
    ['protected_apply_synthetic_lifecycle(text,uuid,uuid,uuid,text,text,bigint)',false],
  ]) {
    const policy=(await pool.query(`SELECT prosecdef,proconfig,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner)))
        acl WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute FROM pg_proc WHERE oid=$1::regprocedure`,
    [signature])).rows[0];
    assert.equal(policy.prosecdef,definer);assert.deepEqual(policy.proconfig,['search_path=pg_catalog']);
    assert.equal(policy.public_execute,false);
  }
  const sourceId=createSyntheticBusinessTemplates()[0].catalogueMedia[0].id;
  const media=await createSyntheticTemplateMediaSource().read(sourceId);
  const business=[];
  for (const { principal } of accepted) {
    const tenantId=principal.tenantId,siteId=randomUUID(),roomId=randomUUID(),integrationId=randomUUID(),assetId=randomUUID();
    await pool.query(`INSERT INTO integrations(tenant_id,id,provider,provider_reference,status)
      VALUES($1,$2,'synthetic_calendar',$3,'active')`,[tenantId,integrationId,`synthetic:${owned.generationId}`]);
    await pool.query("INSERT INTO sites(tenant_id,id,name,time_zone) VALUES($1,$2,'Participant fixture site','Europe/Berlin')",
      [tenantId,siteId]);
    await pool.query(`INSERT INTO rooms(tenant_id,id,site_id,name,capacity,details)
      VALUES($1,$2,$3,'Participant fixture room',8,jsonb_build_object('floorplanAssetId',$4::text))`,[tenantId,roomId,siteId,assetId]);
    await pool.query(`INSERT INTO synthetic_catalogue_media_assets(tenant_id,id,owner_kind,owner_id,bytes,content_type,
      byte_length,content_sha256,alt_text,created_at,created_by_user_id)
      VALUES($1,$2,'room_plan',$3,$4,$5,$6,$7,'Participant fixture plan',clock_timestamp(),$8)`,
    [tenantId,assetId,roomId,media.bytes,media.contentType,media.byteLength,Buffer.from(media.sha256,'hex'),principal.userId]);
    const target=issued.find(row=>row.tenantId===tenantId);
    if (target.slot==='fabrikam') {
      for (const capability of ['microsoft.directory','microsoft.calendar']) await pool.query(
        'INSERT INTO tenant_entitlements(tenant_id,capability_id,enabled) VALUES($1,$2,true)',[tenantId,capability]);
      const service=createSyntheticOnboardingService({ authorizationPolicy: createAuthorizationPolicy(),
        auditService: createAuditService({ repository: customerAudit,authorizationPolicy: createAuthorizationPolicy() }),
        repository: createPostgresSyntheticOnboardingRepository(customerPool,
          { scope: syntheticScope,auditRepository: customerAudit,syntheticParticipantsEnabled: true }) });
      const context={ principal,tenantContext: { tenantId,status: 'onboarding' },correlationId: randomUUID() };
      const before=await shared(()=>service.view(context));
      const imported=await shared(()=>service.importRooms(context,
        { expectedRevision: before.locationsRevision,selectedKeys: ['workshop','focus'] }));
      assert.equal(imported.importedCount,2);assert.equal(imported.boundRoomCount,3);
      const lifecycleSql='SELECT protected_synthetic_participant_lifecycle($1,$2,$3,$4,$5,$6) AS allowed';
      const lifecycleValues=['int',epoch,principal.session.id,'onboarding','ready',imported.locationsRevision];
      for (const values of [['prod',...lifecycleValues.slice(1)],['int',randomUUID(),...lifecycleValues.slice(2)],
        ['int',epoch,randomUUID(),...lifecycleValues.slice(3)]]) {
        assert.equal((await customerPool.query(lifecycleSql,values)).rows[0].allowed,false);
      }
      // Each denial has otherwise complete resources/entitlements and current
      // revision; the following successful transition proves the target is ready.
      for (const mutation of [
        { text: "DELETE FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2 AND role='tenant_admin'",
          values: [tenantId,principal.userId] },
        { text: 'UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',values: [tenantId,principal.userId] },
        { text: 'UPDATE sessions SET revoked_at=clock_timestamp() WHERE id=$1',values: [principal.session.id] },
        { text: "UPDATE sessions SET provider='test_identity' WHERE id=$1",values: [principal.session.id] },
        { text: "UPDATE sessions SET expires_at=issued_at+interval '1 millisecond' WHERE id=$1",values: [principal.session.id] },
        { text: "UPDATE user_identity_bindings SET provider_user_reference=$3 WHERE tenant_id=$1 AND user_id=$2 AND provider='email_code'",
          values: [tenantId,principal.userId,randomUUID()] },
      ]) await assert.rejects(shared(()=>withPostgresTransaction(customerPool,async client=>{
        assert.equal((await client.query(mutation)).rowCount,1);
        assert.equal((await client.query(lifecycleSql,lifecycleValues)).rows[0].allowed,false);
        throw new Error('RESTORE_ISOLATED_PARTICIPANT_SOURCE');
      })),/RESTORE_ISOLATED_PARTICIPANT_SOURCE/);
      const failingAudit=createSyntheticOnboardingService({ authorizationPolicy: createAuthorizationPolicy(),
        auditService: createAuditService({ repository: customerAudit,authorizationPolicy: createAuthorizationPolicy() }),
        repository: createPostgresSyntheticOnboardingRepository(customerPool,{ scope: syntheticScope,syntheticParticipantsEnabled: true,
          auditRepository: { async appendWithClient() { throw new Error('ISOLATED_ONBOARDING_AUDIT_FAILURE'); } } }) });
      await assert.rejects(shared(()=>failingAudit.transition(context,{ expectedRevision: imported.locationsRevision,
        expectedStatus: 'onboarding',targetStatus: 'ready' })),/ISOLATED_ONBOARDING_AUDIT_FAILURE/);
      assert.equal((await pool.query('SELECT status FROM tenants WHERE id=$1',[tenantId])).rows[0].status,'onboarding');
      const ready=await shared(()=>service.transition(context,{ expectedRevision: imported.locationsRevision,
        expectedStatus: 'onboarding',targetStatus: 'ready' }));assert.equal(ready.tenantStatus,'ready');
      const active=await shared(()=>service.transition({ ...context,tenantContext: { tenantId,status: 'ready' } },
        { expectedRevision: ready.locationsRevision,expectedStatus: 'ready',targetStatus: 'active' }));
      assert.equal(active.tenantStatus,'active');
    } else await pool.query("UPDATE tenants SET status='active' WHERE id=$1",[tenantId]);
    const accessInput={ ...protection,principal };
    const current=await shared(()=>withPostgresTransaction(customerPool,
      client=>businessCustody.lockCurrentAccessWithClient(client,accessInput)));
    assert.equal(current.kind,'synthetic_participant');assert.equal(current.runtime.generationId,owned.generationId);
    const catalogue=await shared(()=>mediaRepository.list({ tenantId,principal }));
    assert.equal(catalogue.length,1);assert.equal(catalogue[0].id,assetId);
    const image=await shared(()=>mediaRepository.find({ tenantId,principal,assetId }));assert.deepEqual(image.bytes,media.bytes);
    assert.equal(await shared(()=>withPostgresTransaction(customerPool,client=>calendarGuard.lockBookingIntegration(client,
      { tenantId,integrationId,providerConnectionReference: `synthetic:${owned.generationId}`,principal }))),true);
    const foreign=accepted.find(row=>row.principal.tenantId!==tenantId).principal;
    await assert.rejects(shared(()=>mediaRepository.find({ tenantId,principal: foreign,assetId })),/AUTHORIZATION_DENIED/);
    assert.equal(await shared(()=>withPostgresTransaction(customerPool,client=>calendarGuard.lockCustomerMutation(client,
      { tenantId,principal: foreign }))),false);
    business.push({ tenantId,principal,assetId });
  }
  // Exercise the owned factories with their real random code/namespace ports.
  // The provider is an in-memory test receipt, never operating mail evidence.
  const config=Object.freeze({ ...loadConfig({ NODE_ENV: 'test',PUBLIC_ORIGIN: syntheticScope.customerOrigin,
    AUDIT_HMAC_SECRET: 'a'.repeat(48),CSRF_SECRET: 's'.repeat(48) }),deploymentEnvironment: 'int' });
  const persistence={ pool: customerPool },options={ pool: customerPool,leasePool: customerLease,...protection,cipher,
    publicOrigin: config.publicOrigin,auditHmacSecret: config.auditHmacSecret,csrfSecret: config.csrfSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,emailFlowSecret: 'f'.repeat(48),emailCodeSecret: 'p'.repeat(48),
    emailSourceSecret: 'b'.repeat(48),syntheticParticipantsEnabled: true };
  const invited=createProtectedInvitedCustomerAccess(options);
  const authentication=createProtectedCustomerAuthentication({ ...options,config,persistence,
    synthetic: { platformOrigin: syntheticScope.platformOrigin,platformSecurityEpoch: syntheticScope.platformSecurityEpoch,
      browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48) } });
  const facade=authentication.authenticationFactory({ config,persistence }).sessionService;
  const ownedRun=work=>shared(()=>authentication.writeCustody.run(work)),codes=new Map(),ownedSessions=[];let mailCalls=0;
  const worker=createProtectedCustomerAccessDeliveryWorker({ ...options,provider: { async send(message) {
    mailCalls++;const code=message.text.match(/(?:^|\n)(\d{8})(?:\n|$)/)?.[1];if (code) codes.set(message.recipient,code);
    return { status: 'accepted',messageId: randomUUID() };
  } } });
  let graphCalls=0;
  const graphCall=()=>{ graphCalls++;throw new Error('ISOLATED_REAL_GRAPH_TRIPWIRE'); };
  const graph=authentication.writeCustody.providerClient({ redirectUri: config.publicOrigin+'/callback',adminConsentUrl: graphCall,
    discoverRooms: graphCall,lookupFreeBusy: graphCall,createCalendarEvent: graphCall,updateCalendarEvent: graphCall,
    cancelCalendarEvent: graphCall,verifyBasePermissions: graphCall });
  for (const target of issued) {
    const recipient=`${target.slot}@example.test`,sourceAddress='127.0.0.1';
    const pending=await invited.service.request({ recipient,locale: 'de',sourceAddress });
    assert.equal((await worker.runOnce()).status,'accepted');assert.equal(typeof codes.get(recipient),'string');
    const verified=await invited.service.verify({ ...pending,code: codes.get(recipient),sourceAddress });
    assert.equal(verified.status,'membership_required');
    const choices=await invited.service.choices(verified);assert.equal(choices.items.length,1);
    const issuedSession=await invited.service.select({ ...verified,correlationId: randomUUID() },
      { membershipId: choices.items[0].membershipId });
    const request={ headers: { cookie: issuedSession.setCookie.split(';')[0] } };
    const principal=await ownedRun(async()=>{
      const current=await facade.resolvePrincipal(request);assert.equal(current.tenantId,target.tenantId);
      const changed=await withPostgresTransaction(customerPool,client=>client.query(
        'UPDATE tenants SET display_name=display_name WHERE id=$1 RETURNING id',[current.tenantId]));
      assert.equal(changed.rowCount,1);
      await assert.rejects(async()=>graph.createCalendarEvent({}),/AUTHORIZATION_DENIED/);return current;
    });
    const context={ principal,tenantContext: { tenantId: target.tenantId,status: 'active' },correlationId: randomUUID() };
    await assert.rejects(ownedRun(async()=>{
      await facade.resolvePrincipal(request);return invited.invitationService.issueBatch(context,
        { commandId: randomUUID(),invitations: [{ recipient: 'Blocked@example.test',roles: ['tenant_admin'],locale: 'de' }] });
    }),/RESOURCE_NOT_AVAILABLE/);
    await assert.rejects(ownedRun(async()=>{
      await facade.resolvePrincipal(request);return invited.groupRoleService.get(context);
    }),/MICROSOFT_ROLE_MAPPING_NOT_AUTHORIZED/);
    ownedSessions.push({ request,principal });
  }
  assert.equal(graphCalls,0);assert.equal((await worker.runOnce()).status,'idle');
  // Canonical unregistered history on the SAME otherwise eligible Tenant cannot
  // acquire the new path merely because another approved member exists there.
  const unregistered=await createInvitedCustomerFixture(pool,t,{ targetTenantId: owned.tenants[2].tenantId,
    recipient: 'Unregistered@example.test' });
  assert.equal(await eligible(unregistered.tenantId,{ membershipId: unregistered.membershipId }),false);
  const sessionHistory=async()=>(await pool.query(`SELECT jsonb_build_object(
    'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM sessions s),
    'audit',(SELECT jsonb_agg(to_jsonb(a) ORDER BY tenant_id,id) FROM audit_events a)) AS value`)).rows[0].value;
  const beforeDeniedIssue=await sessionHistory();
  await assert.rejects(shared(()=>sessions.issue({ tenantId: unregistered.principal.tenantId,
    userId: unregistered.principal.userId,securityVersion: unregistered.principal.session.securityVersion,
    providerIdentity: unregistered.principal.providerIdentity,roles: unregistered.principal.roles,
    permissions: unregistered.principal.permissions },{ correlationId: randomUUID() })),/IDENTITY_NOT_PROVISIONED/);
  assert.deepEqual(await sessionHistory(),beforeDeniedIssue);
  // User disablement must deny current custody independently of the owner. Use
  // rollback to retain the accepted sessions for the later owner-source checks.
  await assert.rejects(shared(()=>withPostgresTransaction(customerPool,async client=>{
    const current=accepted[0];
    await client.query('UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',
      [current.principal.tenantId,current.principal.userId]);
    assert.equal(await sessions.resolvePrincipal(current.request),null);
    throw new Error('RESTORE_ISOLATED_DISABLED_USER');
  })),/RESTORE_ISOLATED_DISABLED_USER/);
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
  assert.equal(await rollbackLatest(pool),true); // Function-only074 retains participant history before the073 recovery guard.
  await assert.rejects(rollbackLatest(pool),/SYNTHETIC_PARTICIPANT_HISTORY_REQUIRES_VERIFIED_RECOVERY/);
  await migrateUp(pool);
  assert.equal(await isPostgresSchemaReady(pool,74),true);
  for (const { tenantId } of owned.tenants) assert.equal(await audit.verifyTenantChain(tenantId),true);
  // Human membership source custody is independent of a delegated live Owner
  // session, but it cannot survive current owner disablement/security changes.
  await pool.query('UPDATE platform_sessions SET revoked_at=clock_timestamp() WHERE operator_id=$1',[owner.operator.operatorId]);
  assert.equal(await eligible(bindings[0].tenant_id,{ membershipId: bindings[0].membership_id }),true);
  for (const row of accepted) assert.ok(await shared(()=>sessions.resolvePrincipal(row.request)));
  for (const row of ownedSessions) assert.ok(await ownedRun(()=>facade.resolvePrincipal(row.request)));
  // Drain the unrelated ordinary REAL invitation created by the strict-scope
  // progression before isolating the queued participant-disablement case.
  let drained=false;
  for (let index=0;index<10;index++) {
    const outcome=await worker.runOnce();
    if (outcome.status==='idle') { drained=true;break; }
    assert.equal(outcome.status,'accepted');
  }
  assert.equal(drained,true);
  await invited.service.request({ recipient: `${issued[0].slot}@example.test`,locale: 'de',sourceAddress: '127.0.0.1' });
  const beforeDisabledDispatch=mailCalls;
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operator.operatorId]);
  assert.equal(await eligible(bindings[0].tenant_id,{ membershipId: bindings[0].membership_id }),false);
  assert.equal((await worker.runOnce()).status,'idle');assert.equal(mailCalls,beforeDisabledDispatch);
  for (const row of accepted) assert.equal(await shared(()=>sessions.resolvePrincipal(row.request)),null);
  for (const row of ownedSessions) {
    assert.equal(await ownedRun(()=>facade.resolvePrincipal(row.request)),null);
    await assert.rejects(ownedRun(async()=>{
      await authentication.writeCustody.observe(row.principal);
      return withPostgresTransaction(customerPool,client=>client.query(
        "UPDATE tenants SET display_name='Forbidden stale participant' WHERE id=$1",[row.principal.tenantId]));
    }),/AUTHORIZATION_DENIED/);
  }
  for (const row of business) {
    await assert.rejects(shared(()=>mediaRepository.find(row)),/AUTHORIZATION_DENIED/);
    assert.equal(await shared(()=>withPostgresTransaction(customerPool,client=>calendarGuard.lockCustomerMutation(client,row))),false);
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM platform_passkey_credentials')).rows[0].n,0);
});
