import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { loadProtectedCustomerConfiguration } from '../src/protected-customer-config.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createProtectedSyntheticMicrosoftFixture } from './support/protected-synthetic-microsoft-fixture.js';
import { createPostgresSyntheticGenerationRepository } from '../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createSyntheticGenerationService } from '../src/platform/application/synthetic-generation-service.js';
import { createPlatformAuthorizationPolicy } from '../src/platform/identity/policy.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createInvitedCustomerFixture } from './support/invited-customer-fixture.js';
import { createProtectedPostgresTlsFixture } from './support/protected-postgres-tls-fixture.js';
import { unusedProtectedRuntimePort,startProtectedRuntimeProcess,exchangeProtectedRuntime }
  from './support/protected-runtime-process-fixture.js';

const unusedPort=unusedProtectedRuntimePort;
const childRuntime=environment=>startProtectedRuntimeProcess('customer',environment);
const exchange=(...args)=>exchangeProtectedRuntime('customer',...args);
const pair=value=>value.split(';')[0];

test('native owned Customer root verifies TLS/SCRAM, refuses bad credentials/CA and admits invited email through restricted HTTP',
async t=>{
  const fixture=await createProtectedPostgresTlsFixture(t),children=[];let leasePool=null;
  const pool=new pg.Pool({ connectionString: fixture.url.href,ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    max: 2,connectionTimeoutMillis: 2000,statement_timeout: 10000 });pool.on('error',()=>{});
  t.after(async()=>{
    try { for (const child of children) await child.stop(); }
    finally { try { if (leasePool) await leasePool.end();await pool.end(); } finally { await fixture.destroy(); } }
  });await migrateUp(pool);
  const epoch=randomUUID(),roles=['cm_protected_int_customer','cm_protected_int_platform'];
  const passwords=roles.map(()=>randomBytes(32).toString('hex'));
  for (const [index,role] of roles.entries()) {
    assert.match(passwords[index],/^[a-f0-9]{64}$/);
    await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${passwords[index]}'`);
  }
  assert.equal((await pool.query(`SELECT bool_and(rolpassword LIKE 'SCRAM-SHA-256$%') AS scram
    FROM pg_authid WHERE rolname=ANY($1::text[])`,[roles])).rows[0].scram,true);
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  await grantProtectedRuntimeRoles(pool,{ environment: 'int',securityEpoch: epoch });
  const customerUrl=new URL(fixture.url);customerUrl.username=roles[0];customerUrl.password=passwords[0];
  const wrongUrl=new URL(customerUrl);wrongUrl.password=randomBytes(32).toString('hex');
  const denied=new pg.Client({ connectionString: wrongUrl.href,ssl: { ca: fixture.certificate,rejectUnauthorized: true },
    connectionTimeoutMillis: 2000 });
  try { await assert.rejects(denied.connect(),{ code: '28P01' }); } finally { await denied.end(); }
  const wrongName=new pg.Client({ connectionString: customerUrl.href,
    ssl: { ca: fixture.certificate,rejectUnauthorized: true,servername: 'foreign.invalid' },connectionTimeoutMillis: 2000 });
  try { await assert.rejects(wrongName.connect(),{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }); } finally { await wrongName.end(); }
  const environment={ NODE_ENV: 'production',NODE_EXTRA_CA_CERTS: fixture.caPath,
    PROTECTED_ENVIRONMENT: 'int',PROTECTED_SECURITY_EPOCH: epoch,PROTECTED_PLATFORM_SECURITY_EPOCH: '7',
    PROTECTED_DATABASE_POOL_MAX: '1',PROTECTED_LEASE_POOL_MAX: '1',
    PROTECTED_CUSTOMER_ORIGIN: 'https://app-int.example.test',PROTECTED_PLATFORM_ORIGIN: 'https://ops-int.example.com',
    PROTECTED_API_COMMIT: 'a'.repeat(40),PROTECTED_FRONTEND_COMMIT: 'b'.repeat(40),PROTECTED_SERVICE_VERSION: '1.0.0',
    PROTECTED_CUSTOMER_DATABASE_URL: customerUrl.href,PROTECTED_CUSTOMER_HOST: '127.0.0.1',
    PROTECTED_CUSTOMER_PORT: String(await unusedPort()),PROTECTED_CUSTOMER_ENTRA_CLIENT_ID: randomUUID(),
    PROTECTED_PEER_ENTRA_CLIENT_ID: randomUUID(),PROTECTED_CUSTOMER_ENTRA_CLIENT_SECRET: 'e'.repeat(48),
    PROTECTED_CUSTOMER_CSRF_SECRET: 's'.repeat(48),PROTECTED_TENANT_AUDIT_HMAC_SECRET: 'a'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_FLOW_SECRET: 'f'.repeat(48),PROTECTED_CUSTOMER_EMAIL_CODE_SECRET: 'p'.repeat(48),
    PROTECTED_CUSTOMER_EMAIL_SOURCE_SECRET: 'b'.repeat(48),PROTECTED_CUSTOMER_MICROSOFT_FLOW_SECRET: 'm'.repeat(48),
    PROTECTED_CUSTODY_LOOKUP_SECRET: 'l'.repeat(48),PROTECTED_CUSTODY_ACTIVE_KEY_ID: 'initial',
    PROTECTED_CUSTODY_KEYRING: JSON.stringify([{ id: 'initial',key: Buffer.alloc(32,3).toString('base64url') }]) };
  const badPassword=await childRuntime({ ...environment,PROTECTED_CUSTOMER_DATABASE_URL: wrongUrl.href });children.push(badPassword);
  assert.equal(badPassword.outcome.type,'failed');assert.equal((await badPassword.stop()).code,1);
  const untrusted={ ...environment };delete untrusted.NODE_EXTRA_CA_CERTS;
  const badCa=await childRuntime(untrusted);children.push(badCa);
  assert.equal(badCa.outcome.type,'failed');assert.equal((await badCa.stop()).code,1);
  const wrongHostUrl=new URL(customerUrl);wrongHostUrl.hostname='localhost';
  const badHost=await childRuntime({ ...environment,NODE_OPTIONS: '--dns-result-order=ipv4first',
    PROTECTED_CUSTOMER_DATABASE_URL: wrongHostUrl.href });children.push(badHost);
  assert.equal(badHost.outcome.type,'failed');assert.equal((await badHost.stop()).code,1);
  await assert.rejects(exchange(Number(environment.PROTECTED_CUSTOMER_PORT),'/api/v1/health/live'),{ code: 'ECONNREFUSED' });

  const real=await createInvitedCustomerFixture(pool,t,{ recipient: 'Setup@example.test' });
  await pool.query("INSERT INTO tenant_runtime_registry(environment,tenant_id,mode) VALUES('int',$1,'real')",[real.tenantId]);
  const bundle=loadProtectedCustomerConfiguration(environment);t.after(()=>bundle.cipher.destroy());
  const invitations=createCustomerInvitationService({ environment: 'int',authorizationPolicy: real.authorizationPolicy,
    auditService: real.auditService,repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',
      cipher: bundle.cipher,content: createCustomerAccessEmailContent({ environment: 'int',publicOrigin: bundle.config.publicOrigin }),
      auditRepository: real.auditRepository }) });
  await invitations.issueBatch({ principal: real.principal,tenantContext: { tenantId: real.tenantId,status: 'onboarding' },
    correlationId: randomUUID() },{ commandId: randomUUID(),
    invitations: [{ recipient: 'Root@example.test',roles: ['tenant_admin'],locale: 'de' }] });
  const runtime=await childRuntime(environment);children.push(runtime);assert.equal(runtime.outcome.type,'listening');
  const port=runtime.outcome.port,call=(path,input)=>exchange(port,path,input);
  assert.equal((await call('/api/v1/health/ready')).status,200);
  const email=await call('/api/v1/auth/email/challenges',{ method: 'POST',body: { recipient: 'Root@example.test',locale: 'de' } });
  assert.equal(email.status,202);const emailCookie=pair(email.headers['set-cookie'][0]);
  const delivery=(await pool.query(`SELECT * FROM customer_access_deliveries WHERE purpose='mailbox_code'
    ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
  const bytes=bundle.cipher.open(delivery.payload_envelope,{ environment: 'int',mailboxId: delivery.mailbox_id,
    recordId: delivery.id,purpose: 'mailbox_code',tenantId: null });
  let code;try { code=JSON.parse(bytes.toString('utf8')).text.match(/\b\d{8}\b/)[0]; } finally { bytes.fill(0); }
  const verified=await call('/api/v1/auth/email/verify',{ method: 'POST',body: { code },
    headers: { cookie: emailCookie,'x-csrf-token': JSON.parse(email.text).csrfToken } });assert.equal(verified.status,200);
  const choiceCookie=pair(verified.headers['set-cookie'][0]);
  const choices=await call('/api/v1/auth/email/choices',{ headers: { cookie: choiceCookie } });assert.equal(choices.status,200);
  const selection={ method: 'POST',body: { membershipId: JSON.parse(choices.text).items[0].membershipId },
    headers: { cookie: choiceCookie,'x-csrf-token': JSON.parse(verified.text).csrfToken } };
  assert.equal((await call('/api/v1/auth/email/selection',{ ...selection,
    headers: { ...selection.headers,'x-csrf-token': '0'.repeat(64) } })).status,401);
  const admitted=await call('/api/v1/auth/email/selection',selection);assert.equal(admitted.status,204);
  const cookie=pair(admitted.headers['set-cookie'][0]);
  assert.equal((await call('/api/v1/session',{ headers: { cookie } })).status,200);
  assert.equal((await call('/api/v1/tenant/invitations',{ headers: { cookie } })).status,200);
  assert.equal((await call('/api/v1/session',{ headers: { cookie: real.cookie } })).status,401);
  assert.equal((await call('/api/v1/auth/email/selection',selection)).status,401);
  assert.equal(await real.auditRepository.verifyTenantChain(real.tenantId),true);
  leasePool=new pg.Pool({ connectionString: fixture.url.href,
    ssl: { ca: fixture.certificate,rejectUnauthorized: true },max: 1 });leasePool.on('error',()=>{});
  const owner=await createProtectedSyntheticMicrosoftFixture(pool,leasePool,{ epoch });
  const tenantAuditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const generationService=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,assuranceMode: 'microsoft_mfa',
    passkeyService: owner.auth,authorizationPolicy: createPlatformAuthorizationPolicy(),
    repository: createPostgresSyntheticGenerationRepository(pool,{ environment: 'int',securityEpoch: epoch,
      assuranceMode: 'microsoft_mfa',calendarEnabled: true,tenantAuditRepository,platformAuditRepository: owner.auditRepository }) });
  const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
  const generation=await owner.execute(generationService.operationHash(intent),proofContext=>generationService.replace({
    proofContext,intent,correlationId: randomUUID() }));
  for (const target of generation.tenants) {
    await createInvitedCustomerFixture(pool,t,{ recipient: `${target.slot}@example.test`,targetTenantId: target.tenantId,accept: false,
      async beforeAdmission({ invitation }) {
        await pool.query(`INSERT INTO synthetic_invited_memberships
          (environment,tenant_id,membership_id,invitation_id,generation_id,operator_id,slot)
          SELECT 'int',$1,membership_id,id,$3,$4,$5 FROM customer_member_invitations
          WHERE environment='int' AND tenant_id=$1 AND id=$2`,
        [target.tenantId,invitation.id,generation.generationId,owner.operatorId,target.slot]);
      } });
  }
  const enabled={ ...environment,PROTECTED_CUSTOMER_PORT: String(await unusedPort()),
    PROTECTED_SYNTHETIC_ENABLED: 'true',PROTECTED_HANDOFF_SECRET: 'h'.repeat(48),PROTECTED_SYNTHETIC_PARTICIPANTS_ENABLED: 'true' };
  const lifecycle='protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint)';
  await pool.query(`REVOKE EXECUTE ON FUNCTION ${lifecycle} FROM cm_protected_int_customer`);
  const missingGrant=await childRuntime(enabled);children.push(missingGrant);
  assert.equal(missingGrant.outcome.type,'failed');assert.equal((await missingGrant.stop()).code,1);
  assert.equal((await call('/api/v1/health/ready')).status,200);
  await pool.query(`GRANT EXECUTE ON FUNCTION ${lifecycle} TO cm_protected_int_customer`);
  const participantRuntime=await childRuntime(enabled);children.push(participantRuntime);
  assert.equal(participantRuntime.outcome.type,'listening');
  const participant=(path,input)=>exchange(participantRuntime.outcome.port,path,input),participantCookies=[],privateCodes=[];
  assert.equal((await participant('/api/v1/health/ready')).status,200);
  for (const target of generation.tenants) {
    const pending=await participant('/api/v1/auth/email/challenges',{ method: 'POST',
      body: { recipient: `${target.slot}@example.test`,locale: 'de' } });assert.equal(pending.status,202);
    const transactionCookie=pair(pending.headers['set-cookie'][0]);
    const queued=(await pool.query(`SELECT delivery.* FROM customer_access_deliveries delivery
      JOIN customer_email_challenges challenge ON challenge.environment=delivery.environment AND challenge.id=delivery.challenge_id
      JOIN customer_access_memberships member ON member.environment=challenge.environment AND member.mailbox_id=challenge.mailbox_id
      WHERE member.tenant_id=$1 AND delivery.purpose='mailbox_code' ORDER BY delivery.created_at DESC LIMIT 1`,[target.tenantId])).rows[0];
    const payload=bundle.cipher.open(queued.payload_envelope,{ environment: 'int',mailboxId: queued.mailbox_id,
      recordId: queued.id,purpose: 'mailbox_code',tenantId: null });
    let value;try { value=JSON.parse(payload.toString('utf8')).text.match(/\b\d{8}\b/)[0]; } finally { payload.fill(0); }
    privateCodes.push(value);
    const verifiedParticipant=await participant('/api/v1/auth/email/verify',{ method: 'POST',body: { code: value },
      headers: { cookie: transactionCookie,'x-csrf-token': JSON.parse(pending.text).csrfToken } });
    assert.equal(verifiedParticipant.status,200);const choicesCookie=pair(verifiedParticipant.headers['set-cookie'][0]);
    const available=await participant('/api/v1/auth/email/choices',{ headers: { cookie: choicesCookie } });
    assert.equal(available.status,200);
    const items=JSON.parse(available.text).items;assert.equal(items.length,1);
    const select={ method: 'POST',body: { membershipId: items[0].membershipId },
      headers: { cookie: choicesCookie,'x-csrf-token': JSON.parse(verifiedParticipant.text).csrfToken } };
    const admittedParticipant=await participant('/api/v1/auth/email/selection',select);assert.equal(admittedParticipant.status,204);
    const sessionCookie=pair(admittedParticipant.headers['set-cookie'][0]);participantCookies.push(sessionCookie);
    const view=await participant('/api/v1/session',{ headers: { cookie: sessionCookie } });assert.equal(view.status,200);
    assert.equal(JSON.parse(view.text).tenant.id,target.tenantId);
    assert.deepEqual(JSON.parse(view.text).roles,['employee','tenant_admin']);
    assert.equal((await call('/api/v1/session',{ headers: { cookie: sessionCookie } })).status,401);
    assert.equal((await participant('/api/v1/tenant/invitations',{ headers: { cookie: sessionCookie } })).status,403);
    const onboarding=await participant('/api/v1/integrations/synthetic-calendar',{ headers: { cookie: sessionCookie } });
    assert.equal(onboarding.status,200);assert.equal(JSON.parse(onboarding.text).mode,'synthetic');
    if (target.slot==='fabrikam') {
      const expectedRevision=JSON.parse(onboarding.text).locationsRevision;
      const headers={ cookie: sessionCookie,'x-csrf-token': JSON.parse(view.text).csrfToken };
      const imported=await participant('/api/v1/integrations/synthetic-calendar/rooms/import',{
        method: 'POST',body: { expectedRevision,selectedKeys: ['workshop','focus'] },headers });
      assert.equal(imported.status,200);assert.equal(JSON.parse(imported.text).importedCount,2);
      let revision=JSON.parse(imported.text).locationsRevision;
      for (const [expectedStatus,targetStatus] of [['onboarding','ready'],['ready','active']]) {
        const transitioned=await participant('/api/v1/integrations/synthetic-calendar/lifecycle/transitions',{
          method: 'POST',body: { expectedRevision: revision,expectedStatus,targetStatus },headers });
        assert.equal(transitioned.status,200);assert.equal(JSON.parse(transitioned.text).tenantStatus,targetStatus);
        revision=JSON.parse(transitioned.text).locationsRevision;
      }
    }
  }
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[owner.operatorId]);
  for (const sessionCookie of participantCookies) {
    assert.equal((await participant('/api/v1/session',{ headers: { cookie: sessionCookie } })).status,401);
  }
  assert.equal((await call('/api/v1/session',{ headers: { cookie } })).status,200);
  assert.equal((await participantRuntime.stop()).code,0);
  for (const target of generation.tenants) assert.equal(await tenantAuditRepository.verifyTenantChain(target.tenantId),true);
  for (const secret of [...participantCookies,...privateCodes]) {
    assert.equal(children.some(child=>child.logs().includes(secret)),false);
  }
  assert.equal((await runtime.stop()).code,0);
  for (const value of [fixture.password,...passwords,wrongUrl.password,code,cookie,emailCookie,choiceCookie]) {
    assert.equal(children.some(child=>child.logs().includes(value)),false,'root logs must exclude private fixture material');
  }
});
