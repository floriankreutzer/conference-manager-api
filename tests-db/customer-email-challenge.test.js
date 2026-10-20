import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerEmailFlowBinding } from '../src/identity/customer-email-flow-binding.js';
import { createCustomerEmailAdmissionService } from '../src/identity/customer-email-admission-service.js';
import { createPostgresCustomerEmailAdmissionRepository } from '../src/persistence/postgres/customer-email-admission-repository.js';
import { createEmailMailboxProofFactory } from '../src/identity/email-code-proof.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { createPostgresCustomerEmailChallengeRepository } from '../src/persistence/postgres/customer-email-challenge-repository.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const id = number => `f0000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
test('mailbox code custody keeps unknown flows uniform and rotates proof without issuing Tenant authority', async t => {
  const database = loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test',...database }); t.after(() => pool.end()); await migrateUp(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const auditService = createAuditService({ repository: auditRepository,authorizationPolicy });
  const sessions = createSessionService({ repository: createPostgresSessionRepository(pool,{ auditRepository }),auditService,
    publicOrigin: 'https://customer-int.example.com',csrfSecret: 's'.repeat(48) });
  const cipher = createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) }); t.after(() => cipher.destroy());
  const content = createCustomerAccessEmailContent({ environment: 'int',publicOrigin: 'https://customer-int.example.com' });
  const flowBinding = createCustomerEmailFlowBinding({ environment: 'int',secret: 'f'.repeat(48) }); t.after(() => flowBinding.destroy());
  const proofFactory = createEmailMailboxProofFactory({ environment: 'int',secret: 'p'.repeat(48),codeFactory: () => '00001234' });
  const challenges = createPostgresCustomerEmailChallengeRepository(pool,{ environment: 'int',cipher,content,flowBinding,proofFactory });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic Mailbox Tenant','onboarding')",[id(1)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic Admin')",[id(1),id(2)]);
  await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[id(1),id(2)]);
  const session = await sessions.issue({ tenantId: id(1),userId: id(2),securityVersion: 1,
    ...tenantAuthorizationSnapshot(['employee','tenant_admin']),providerIdentity: { provider: 'test_identity',reference: id(2) } },
  { correlationId: id(3) });
  const invitations = createCustomerInvitationService({ authorizationPolicy,auditService,environment: 'int',
    repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,content,auditRepository }) });
  await invitations.issueBatch({ principal: session.principal,
    tenantContext: { tenantId: id(1),status: 'onboarding' },correlationId: id(3) },
    { commandId: id(4),invitations: [{ recipient: 'Invited@example.com',locale: 'de',roles: ['tenant_admin'] }] });
  const sourceKey = 'c'.repeat(64);
  const unknown = await challenges.request({ recipient: 'Unknown@example.com',locale: 'de',sourceKey });
  const known = await challenges.request({ recipient: 'Invited@example.com',locale: 'de',sourceKey });
  assert.deepEqual(Object.keys(known).sort(),Object.keys(unknown).sort());
  assert.deepEqual(Object.keys(await challenges.pending(known)),Object.keys(await challenges.pending(unknown)));
  assert.equal((await challenges.pending(unknown)).status,'code_required');
  assert.equal((await challenges.verify({ ...unknown,code: '00001234',sourceKey })).status,'rejected');
  const count = async () => (await pool.query('SELECT attempt_count FROM customer_email_challenges WHERE id=$1',[known.challengeId]))
    .rows[0].attempt_count;
  assert.equal((await challenges.verify({ ...known,csrfToken: '0'.repeat(64),code: '00001234',sourceKey })).status,'rejected');
  assert.equal(await count(),0);
  assert.equal((await challenges.verify({ ...known,browserToken: unknown.browserToken,code: '00001234',sourceKey })).status,'rejected');
  assert.equal(await count(),0);
  assert.equal((await challenges.verify({ ...known,code: '99999999',sourceKey })).status,'rejected'); assert.equal(await count(),1);
  const concurrent = await Promise.all([1,2].map(() => challenges.verify({ ...known,code: '00001234',sourceKey })));
  assert.deepEqual(concurrent.map(item => item.status).sort(),['membership_required','rejected']);
  const choice = concurrent.find(item => item.status === 'membership_required');
  assert.notEqual(choice.browserToken,known.browserToken); assert.notEqual(choice.csrfToken,known.csrfToken);
  assert.equal((await challenges.pending(known)).status,'rejected');
  assert.equal((await challenges.pending(choice)).status,'membership_required');
  assert.doesNotMatch(JSON.stringify(choice),/tenantId|mailboxId|roles|permissions|recipient|userId/);
  const persisted = (await pool.query('SELECT to_jsonb(challenge) AS value FROM customer_email_challenges challenge')).rows;
  assert.doesNotMatch(JSON.stringify(persisted),/Invited@example|Unknown@example|00001234|99999999/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,1);
  const deliveries = await pool.query("SELECT count(*)::int AS n FROM customer_access_deliveries WHERE purpose='mailbox_code'");
  assert.equal(deliveries.rows[0].n,1);
  const admissionRepository = createPostgresCustomerEmailAdmissionRepository(pool,{ environment: 'int',flowBinding,auditRepository });
  const admission = createCustomerEmailAdmissionService({ repository: admissionRepository,auditService,sessionService: sessions });
  await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Second Invited Tenant','onboarding')",[id(9)]);
  await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Second Admin')",[id(9),id(10)]);
  await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')",[id(9),id(10)]);
  const secondSession = await sessions.issue({ tenantId: id(9),userId: id(10),securityVersion: 1,
    ...tenantAuthorizationSnapshot(['employee','tenant_admin']),providerIdentity: { provider: 'test_identity',reference: id(10) } },
  { correlationId: id(11) });
  const secondInvite = await invitations.issueBatch({ principal: secondSession.principal,
    tenantContext: { tenantId: id(9),status: 'onboarding' },correlationId: id(11) },
  { commandId: id(12),invitations: [{ recipient: 'Invited@example.com',roles: ['conference_manager'],locale: 'en' }] });
  const secondMember = (await pool.query('SELECT membership_id FROM customer_member_invitations WHERE id=$1',[secondInvite[0].id]))
    .rows[0].membership_id;
  const choices = await admission.choices(choice);
  assert.equal(choices.items.length,1); assert.equal(choices.items[0].displayName,'Synthetic Mailbox Tenant');
  assert.doesNotMatch(JSON.stringify(choices),/tenantId|userId|mailboxId|recipient|roles|permissions/);
  const choose = (flow,membershipId,service = admission) => service.select({ ...flow,correlationId: id(13) },{ membershipId });
  assert.equal((await choose(choice,secondMember)).status,'rejected');
  const accepted = await Promise.all([1,2].map(() => choose(choice,choices.items[0].membershipId)));
  assert.deepEqual(accepted.map(item => item.status).sort(),['authenticated','rejected']);
  const firstLogin = accepted.find(item => item.status === 'authenticated');
  const firstPrincipal = await sessions.resolvePrincipal({ headers: { cookie: firstLogin.setCookie.split(';')[0] } });
  assert.equal(firstPrincipal.tenantId,id(1)); assert.deepEqual(firstPrincipal.roles,['employee','tenant_admin']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,3);
  assert.equal((await admission.choices(choice)).status,'rejected');
  await pool.query('DELETE FROM tenant_user_roles WHERE tenant_id=$1 AND user_id=$2',[id(1),firstPrincipal.userId]);
  await pool.query('UPDATE users SET security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',[id(1),firstPrincipal.userId]);
  async function nextProof(recipient = 'Invited@example.com') {
    await pool.query(`UPDATE customer_access_abuse_budgets SET window_started_at=clock_timestamp()-interval '5 minutes',
      last_issued_at=clock_timestamp()-interval '61 seconds' WHERE environment='int'`);
    const flow = await challenges.request({ recipient,locale: 'de',sourceKey });
    return challenges.verify({ ...flow,code: '00001234',sourceKey });
  }
  const existingProof = await nextProof(),existingChoices = await admission.choices(existingProof);
  assert.equal(existingChoices.items.length,2);
  const existingLogin = await choose(existingProof,choices.items[0].membershipId);
  assert.equal(existingLogin.status,'authenticated');
  const existingPrincipal = await sessions.resolvePrincipal({ headers: { cookie: existingLogin.setCookie.split(';')[0] } });
  assert.equal(existingPrincipal.userId,firstPrincipal.userId); assert.deepEqual(existingPrincipal.roles,['employee']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,3);
  const finalProof = await nextProof();
  await pool.query('UPDATE users SET security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',[id(1),firstPrincipal.userId]);
  assert.equal((await choose(finalProof,choices.items[0].membershipId)).status,'rejected');
  await pool.query('UPDATE users SET active=false WHERE tenant_id=$1 AND id=$2',[id(1),firstPrincipal.userId]);
  assert.equal((await choose(finalProof,choices.items[0].membershipId)).status,'rejected');
  assert.equal(await sessions.resolvePrincipal({ headers: { cookie: existingLogin.setCookie.split(';')[0] } }),null);
  assert.deepEqual((await admission.choices(finalProof)).items.map(item => item.membershipId),[secondMember]);
  async function counts() {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM audit_events) AS audits,(SELECT count(*)::int FROM tenant_user_roles) AS roles`)).rows[0];
  }
  const beforeAcceptance = await counts();
  const sessionFailure = createCustomerEmailAdmissionService({ repository: admissionRepository,auditService,
    sessionService: { async issue(identity,options) {
      await sessions.issue(identity,options); throw new Error('ISSUE_RESULT_LOST');
    } } });
  await assert.rejects(choose(finalProof,secondMember,sessionFailure),/ISSUE_RESULT_LOST/);
  assert.deepEqual(await counts(),beforeAcceptance);
  const invalidAudit = { async appendWithClient(client,event) {
    return auditRepository.appendWithClient(client,event.action === 'tenant.onboarding.invited'
      ? { ...event,metadata: { operation: 'issue' } } : event);
  } };
  const commitFailure = createCustomerEmailAdmissionService({ auditService,sessionService: sessions,
    repository: createPostgresCustomerEmailAdmissionRepository(pool,{ environment: 'int',flowBinding,auditRepository: invalidAudit }) });
  await assert.rejects(choose(finalProof,secondMember,commitFailure),/CUSTOMER_INVITATION_AUDIT_REQUIRED/);
  assert.deepEqual(await counts(),beforeAcceptance);
  assert.equal((await admission.choices(finalProof)).items.length,1);
  const finalLogin = await choose(finalProof,secondMember); assert.equal(finalLogin.status,'authenticated');
  const finalPrincipal = await sessions.resolvePrincipal({ headers: { cookie: finalLogin.setCookie.split(';')[0] } });
  assert.equal(finalPrincipal.tenantId,id(9)); assert.deepEqual(finalPrincipal.roles,['employee','conference_manager']);
  assert.equal((await choose(finalProof,secondMember)).status,'rejected');
  const disabledUser = await pool.query('SELECT active FROM users WHERE tenant_id=$1 AND id=$2',[id(1),firstPrincipal.userId]);
  assert.equal(disabledUser.rows[0].active,false);
  assert.equal(await auditRepository.verifyTenantChain(id(1)),true); assert.equal(await auditRepository.verifyTenantChain(id(9)),true);

  const beforeRevocation = await counts();
  const revokable = await invitations.issueBatch({ principal: session.principal,
    tenantContext: { tenantId: id(1),status: 'onboarding' },correlationId: id(3) },
  { commandId: id(20),invitations: [{ recipient: 'Revoked@example.com',roles: [],locale: 'de' }] });
  const revokedProof = await nextProof('Revoked@example.com'),revokedChoices = await admission.choices(revokedProof);
  assert.equal(revokedChoices.items.length,1);
  await invitations.revoke({ principal: session.principal,tenantContext: { tenantId: id(1),status: 'onboarding' },correlationId: id(3) },
    { invitationId: revokable[0].id,expectedRevision: 1 });
  assert.equal((await admission.choices(revokedProof)).items.length,0);
  assert.equal((await choose(revokedProof,revokedChoices.items[0].membershipId)).status,'rejected');
  const afterRevocation = await counts();
  assert.equal(afterRevocation.users,beforeRevocation.users); assert.equal(afterRevocation.sessions,beforeRevocation.sessions);
  assert.equal(afterRevocation.roles,beforeRevocation.roles); assert.equal(afterRevocation.audits-beforeRevocation.audits,2);
  const original = (await pool.query('SELECT mailbox_id FROM customer_email_challenges WHERE id=$1',[known.challengeId])).rows[0];
  const expiredCode = proofFactory.issue({ challengeId: id(21),mailboxId: original.mailbox_id });
  const expiredFlow = flowBinding.bind({ challengeId: id(21),purpose: 'request' },expiredCode.browserToken);
  await pool.query(`INSERT INTO customer_email_challenges(environment,id,mailbox_id,recipient_lookup_hash,
    flow_browser_verifier,code_verifier,browser_verifier,admission_snapshot,created_at,expires_at)
    SELECT environment,$2,mailbox_id,recipient_lookup_hash,$3,$4,$5,admission_snapshot,
      clock_timestamp()-interval '11 minutes',clock_timestamp()-interval '1 minute'
    FROM customer_email_challenges WHERE id=$1`,
  [known.challengeId,id(21),expiredFlow.browserVerifier,expiredCode.codeVerifier,expiredCode.browserVerifier]);
  const expired = { challengeId: id(21),browserToken: expiredCode.browserToken,csrfToken: expiredFlow.csrfToken };
  assert.equal((await challenges.pending(expired)).status,'rejected');
  assert.equal((await challenges.verify({ ...expired,code: '00001234',sourceKey })).status,'rejected');
  assert.equal((await pool.query('SELECT verified_at FROM customer_email_challenges WHERE id=$1',[id(21)])).rows[0].verified_at,null);
  await invitations.issueBatch({ principal: session.principal,
    tenantContext: { tenantId: id(1),status: 'onboarding' },correlationId: id(3) },
    { commandId: id(22),invitations: [{ recipient: 'Attempts@example.com',roles: [],locale: 'de' }] });
  const lockedFlow = await challenges.request({ recipient: 'Attempts@example.com',locale: 'de',sourceKey });
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await challenges.verify({ ...lockedFlow,code: '99999999',sourceKey })).status,'rejected');
  }
  assert.equal((await challenges.verify({ ...lockedFlow,code: '00001234',sourceKey })).status,'rejected');
  assert.equal((await challenges.pending(lockedFlow)).status,'rejected');
  assert.equal((await pool.query('SELECT attempt_count FROM customer_email_challenges WHERE id=$1',[lockedFlow.challengeId]))
    .rows[0].attempt_count,5);
  assert.equal((await counts()).users,afterRevocation.users); assert.equal((await counts()).sessions,afterRevocation.sessions);
  assert.equal(await auditRepository.verifyTenantChain(id(1)),true);

});
