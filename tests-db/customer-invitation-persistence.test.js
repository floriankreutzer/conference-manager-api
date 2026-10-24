import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createSessionService } from '../src/identity/session-service.js';
import { createCustomerAccessEmailContent } from '../src/integrations/customer-access-email-content.js';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { createPostgresSessionRepository } from '../src/persistence/postgres/session-repository.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { createPostgresCustomerAccessDeliveryRepository } from '../src/persistence/postgres/customer-access-delivery-repository.js';
import { createCustomerAccessDeliveryWorker } from '../src/application/customer-access-delivery-worker.js';

const id = number => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const intent = (recipient = 'Invited+pilot@example.com', roles = ['tenant_admin']) => ({ recipient, roles, locale: 'de' });

test('Customer invitation custody is scoped, encrypted, audit-atomic, single-command and revision-fenced', async t => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool); assert.equal(await isPostgresSchemaReady(pool, 68), true);
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool), true); // Empty058 before the original empty057 rollback probe.
  assert.equal(await rollbackLatest(pool), true); // Empty057; retain all earlier migration history.
  await migrateUp(pool); await migrateUp(pool);
  const authorizationPolicy = createAuthorizationPolicy();
  const auditRepository = createPostgresAuditRepository(pool, { hmacSecret: 'a'.repeat(48) });
  const auditService = createAuditService({ repository: auditRepository, authorizationPolicy });
  const sessions = createSessionService({ repository: createPostgresSessionRepository(pool, { auditRepository }), auditService,
    publicOrigin: 'https://customer-int.example.com', csrfSecret: 's'.repeat(48) });
  const cipher = createCustomerAccessCipher({ environment: 'int', activeKeyId: 'initial',
    keys: new Map([['initial', Buffer.alloc(32, 3)]]), lookupSecret: 'l'.repeat(48) });
  t.after(() => cipher.destroy());
  const content = createCustomerAccessEmailContent({ environment: 'int', publicOrigin: 'https://customer-int.example.com' });
  const repository = createPostgresCustomerInvitationRepository(pool, { environment: 'int', cipher, content, auditRepository });
  const service = createCustomerInvitationService({ repository, authorizationPolicy, auditService, environment: 'int' });
  async function prepareTenant(tenantId, userId) {
    await pool.query("INSERT INTO tenants(id,display_name,status) VALUES($1,'Synthetic Invited Tenant','onboarding')", [tenantId]);
    await pool.query("INSERT INTO users(tenant_id,id,display_name) VALUES($1,$2,'Synthetic Admin')", [tenantId,userId]);
    await pool.query("INSERT INTO tenant_user_roles(tenant_id,user_id,role) VALUES($1,$2,'tenant_admin')", [tenantId,userId]);
    const session = await sessions.issue({ tenantId,userId,securityVersion: 1,
      ...tenantAuthorizationSnapshot(['employee','tenant_admin']), providerIdentity: { provider: 'test_identity', reference: userId } },
    { correlationId: id(90) });
    return { principal: session.principal, tenantContext: { tenantId,status: 'onboarding' },correlationId: id(90) };
  }
  const a = await prepareTenant(id(1),id(2)), b = await prepareTenant(id(3),id(4));
  async function counts() {
    return (await pool.query(`SELECT (SELECT count(*)::int FROM customer_access_mailboxes) AS mailboxes,
      (SELECT count(*)::int FROM customer_access_memberships) AS memberships,
      (SELECT count(*)::int FROM customer_member_invitations) AS invitations,
      (SELECT count(*)::int FROM customer_access_deliveries) AS deliveries,
      (SELECT count(*)::int FROM customer_access_commands) AS commands,
      (SELECT count(*)::int FROM audit_events) AS audits`)).rows[0];
  }
  const command = { commandId: id(10), invitations: [intent(),intent('Second@example.com',['conference_manager'])] };
  let issued;
  await t.test('a complete batch persists encrypted delivery with no User, role, session or outbound-provider mutation', async () => {
    const before = await counts(); issued = await service.issueBatch(a,command);
    assert.equal(issued.length,2); assert.equal(issued[0].state,'pending'); assert.equal(issued[0].delivery,'queued');
    const after = await counts(); assert.equal(after.invitations-before.invitations,2);
    assert.equal(after.deliveries-before.deliveries,2); assert.equal(after.audits-before.audits,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tenant_user_roles')).rows[0].n,2);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n,2);
    const custody = await pool.query(`SELECT (SELECT jsonb_agg(to_jsonb(mailbox)) FROM customer_access_mailboxes mailbox) AS mailboxes,
      (SELECT jsonb_agg(to_jsonb(delivery)) FROM customer_access_deliveries delivery) AS deliveries,
      (SELECT jsonb_agg(result) FROM customer_access_commands) AS receipts,
      (SELECT jsonb_agg(metadata) FROM audit_events) AS audit_metadata`);
    assert.doesNotMatch(JSON.stringify(custody.rows), /Invited\+pilot@example\.com|Second@example\.com|recipient"|00001234/);
    assert.equal(await auditRepository.verifyTenantChain(id(1)),true);
  });
  await t.test('SQL envelope validation accepts the full cryptographic bound and rejects malformed or excessive custody', async () => {
    const envelope = cipher.seal(Buffer.alloc(32768,4),{ environment: 'int',mailboxId: id(60),recordId: id(61),
      purpose: 'mailbox_code',tenantId: null });
    const valid = async value => (await pool.query('SELECT customer_access_envelope_valid($1::jsonb) AS valid',
      [JSON.stringify(value)])).rows[0].valid;
    assert.equal(await valid(envelope),true);
    for (const extra of [{ ciphertext: 'a'.repeat(43692) },{ ciphertext: '@' },{ nonce: 'short' },{ tag: null },{ private: true }]) {
      assert.equal(await valid({ ...envelope,...extra }),false);
    }
  });
  await t.test('concurrent exact replay emits no second delivery/audit and changed intent cannot reuse the command', async () => {
    const before = await counts(); const repeated = await Promise.all([service.issueBatch(a,command),service.issueBatch(a,command)]);
    assert.deepEqual(repeated,[issued,issued]); assert.deepEqual(await counts(),before);
    await assert.rejects(service.issueBatch(a,{ ...command,invitations: [intent('Changed@example.com')] }), /CONFLICT/);
    assert.deepEqual(await counts(),before);
    await assert.rejects(service.issueBatch(a,{ commandId: id(11),invitations: [intent()] }), /CONFLICT/);
    assert.deepEqual(await counts(),before);
  });
  await t.test('foreign objects and environment remain unavailable through both service and direct repository', async () => {
    assert.deepEqual(await service.list(b),[]);
    await assert.rejects(service.revoke(b,{ invitationId: issued[0].id,expectedRevision: 1 }), /RESOURCE_NOT_AVAILABLE/);
    await assert.rejects(repository.list({ ...a,tenantId: id(3),environment: 'int',limit: 10,afterInvitationId: null }));
    await assert.rejects(repository.list({ ...a,tenantId: id(1),environment: 'prod',limit: 10,afterInvitationId: null }));
    assert.equal((await service.list(a)).length,2);
  });
  await t.test('early resend is denied, concurrent revocation succeeds once, and old state is never restored', async () => {
    await assert.rejects(service.reissue(a,{ invitationId: issued[0].id,expectedRevision: 1 }), /CONFLICT/);
    const results = await Promise.allSettled([service.revoke(a,{ invitationId: issued[0].id,expectedRevision: 1 }),
      service.revoke(a,{ invitationId: issued[0].id,expectedRevision: 1 })]);
    assert.equal(results.filter(value => value.status==='fulfilled').length,1);
    const value = results.find(entry => entry.status==='fulfilled').value;
    assert.equal(value.revision,2); assert.equal(value.state,'revoked'); assert.equal(value.delivery,'cancelled');
    await assert.rejects(service.reissue(a,{ invitationId: issued[0].id,expectedRevision: 2 }), /CONFLICT/);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM customer_access_deliveries WHERE status='cancelled'")).rows[0].n,1);
    assert.equal((await service.issueBatch(a,command))[0].state,'pending'); // Immutable original receipt, not reactivation.
    assert.equal((await service.list(a)).find(entry => entry.id===issued[0].id).state,'revoked');
    assert.equal((await service.list(a)).find(entry => entry.id===issued[0].id).delivery,'cancelled');
  });
  await t.test('revocation retains provider acceptance and an in-flight observation instead of inventing another queued send', async () => {
    const messages=await service.issueBatch(b,{ commandId: id(80),
      invitations: [intent('Accepted@example.com',[]),intent('Processing@example.com',[])] });
    await pool.query(`UPDATE customer_access_deliveries SET status='accepted',attempt_count=1,
      provider_message_id=$2,accepted_at=clock_timestamp() WHERE environment='int' AND invitation_id=$1`,[messages[0].id,id(81)]);
    await pool.query(`UPDATE customer_access_deliveries SET status='claimed',attempt_count=1,lease_id=$2,
      lease_until=clock_timestamp()+INTERVAL '45 seconds' WHERE environment='int' AND invitation_id=$1`,[messages[1].id,id(82)]);
    for (const [index,delivery] of ['accepted','processing'].entries()) {
      const revoked=await service.revoke(b,{ invitationId: messages[index].id,expectedRevision: 1 });
      assert.equal(revoked.state,'revoked');assert.equal(revoked.delivery,delivery);
      assert.equal((await service.list(b)).find(entry => entry.id===messages[index].id).delivery,delivery);
    }
    const observations=await pool.query(`SELECT status,provider_message_id,lease_id FROM customer_access_deliveries
      WHERE environment='int' AND tenant_id=$1 ORDER BY status`,[id(3)]);
    assert.deepEqual(observations.rows.map(row => row.status),['accepted','claimed']);
    assert.equal(observations.rows[0].provider_message_id,id(81));assert.equal(observations.rows[1].lease_id,id(82));
    assert.equal(await auditRepository.verifyTenantChain(id(3)),true);
  });
  await t.test('required audit failure rolls back mailbox/membership/invitation, delivery and command together', async () => {
    const failing = createCustomerInvitationService({ environment: 'int',authorizationPolicy,auditService,
      repository: createPostgresCustomerInvitationRepository(pool,{ environment: 'int',cipher,content,
        auditRepository: { async appendWithClient() { throw new Error('SYNTHETIC_AUDIT_FAILED'); } } }) });
    const before = await counts();
    await assert.rejects(failing.issueBatch(a,{ commandId: id(12),invitations: [intent('Rollback@example.com')] }),
      /SYNTHETIC_AUDIT_FAILED/);
    assert.deepEqual(await counts(),before);
  });
  await t.test('stale real sessions are rejected inside persistence before replay or new writes', async () => {
    await pool.query('UPDATE users SET security_version=security_version+1 WHERE tenant_id=$1 AND id=$2',[id(1),id(2)]);
    const before = await counts();
    await assert.rejects(service.issueBatch(a,command), /RESOURCE_NOT_AVAILABLE/);
    await assert.rejects(service.issueBatch(a,{ commandId: id(13),invitations: [intent('Stale@example.com')] }), /RESOURCE_NOT_AVAILABLE/);
    const after = await counts(); assert.equal(after.audits,before.audits+2);
    assert.deepEqual({ ...after,audits: before.audits },before);
  });
  await t.test('immutable scope, recipient-free receipts and populated rollback are enforced by PostgreSQL', async () => {
    await assert.rejects(pool.query('UPDATE customer_access_mailboxes SET lookup_hash=$1,custody_version=custody_version+1',
      ['f'.repeat(64)]), /IMMUTABLE/);
    await assert.rejects(pool.query('UPDATE customer_member_invitations SET elevated_roles=ARRAY[\'conference_manager\']::varchar[]'),
      /INVALID|IMMUTABLE/);
    await assert.rejects(pool.query('UPDATE customer_access_commands SET command_hash=$1',['f'.repeat(64)]), /IMMUTABLE/);
    await assert.rejects(pool.query(`INSERT INTO customer_access_commands
      (environment,tenant_id,id,actor_user_id,command_hash,result,created_at)
      SELECT environment,tenant_id,$1,actor_user_id,command_hash,jsonb_set(result,'{0,recipient}',$2::jsonb),created_at
      FROM customer_access_commands WHERE id=$3`,[id(99),JSON.stringify('Private@example.com'),id(10)]),
    error => error.code==='23514');
    const membership = (await pool.query('SELECT id,mailbox_id FROM customer_access_memberships WHERE tenant_id=$1 LIMIT 1',
      [id(1)])).rows[0];
    await assert.rejects(pool.query(`INSERT INTO customer_access_memberships
      (environment,tenant_id,id,mailbox_id,user_id,accepted_at) VALUES('int',$1,$2,$3,$4,clock_timestamp())`,
    [id(1),id(70),membership.mailbox_id,id(2)]),/CUSTOMER_MEMBERSHIP_MUST_BEGIN_PENDING/);
    await assert.rejects(pool.query(`UPDATE customer_access_memberships SET user_id=$1,accepted_at=clock_timestamp()
      WHERE environment='int' AND tenant_id=$2 AND id=$3`,[id(2),id(1),membership.id]),/CUSTOMER_MEMBERSHIP_ACCEPTANCE_REQUIRED/);
    assert.equal((await pool.query('SELECT user_id FROM customer_access_memberships WHERE id=$1',[membership.id])).rows[0].user_id,null);
    assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
    assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
    assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
    assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
    assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
    assert.equal(await rollbackLatest(pool),true); // Empty Microsoft058 before the populated immutable Customer057 guard.
    await assert.rejects(rollbackLatest(pool), /CUSTOMER_ACCESS_REQUIRES_VERIFIED_RECOVERY/);
    await migrateUp(pool); // Restore current059 for subsequent delivery cases.
  });
  await t.test('real outbox claims fence concurrent workers and retain honest acceptance, failure and revoked eligibility',async () => {
    const dispatch=createPostgresCustomerAccessDeliveryRepository(pool,{ environment: 'int',cipher });
    const otherEnvironment=createPostgresCustomerAccessDeliveryRepository(pool,{ environment: 'prod',cipher });
    assert.equal(await otherEnvironment.claim(),null);
    // Earlier cancelled/accepted/in-flight rows remain unchanged. Only the
    // second original, still eligible invitation is available to these workers.
    const attempts=await Promise.all([dispatch.claim(),dispatch.claim()]);
    assert.equal(attempts.filter(Boolean).length,1);
    const claimed=attempts.find(Boolean);assert.equal(claimed.attemptCount,1);
    assert.equal(claimed.message.recipient,'Second@example.com');assert.equal(claimed.message.deliveryId,claimed.deliveryId);
    assert.equal(await dispatch.settle({ deliveryId: claimed.deliveryId,leaseId: id(150),status: 'accepted',
      providerMessageId: id(151),retryDelayMs: null }),null);
    assert.equal(await dispatch.settle({ deliveryId: claimed.deliveryId,leaseId: claimed.leaseId,status: 'accepted',
      providerMessageId: id(151),retryDelayMs: null }),'accepted');
    assert.equal(await dispatch.settle({ deliveryId: claimed.deliveryId,leaseId: claimed.leaseId,status: 'failed',
      providerMessageId: null,retryDelayMs: null }),null);
    await assert.rejects(service.list(a),/RESOURCE_NOT_AVAILABLE/); // The stale Admin stays denied.
    const c=await prepareTenant(id(160),id(161));
    const batch=await service.issueBatch(c,{ commandId: id(162),invitations: [intent('Dispatch@example.com',[])] });
    let sends=0;
    const worker=createCustomerAccessDeliveryWorker({ repository: dispatch,provider: { async send(message) {
      sends++;assert.equal(message.recipient,'Dispatch@example.com');return { status: 'accepted',messageId: id(163) };
    } } });
    assert.equal((await worker.runOnce()).status,'accepted');assert.equal(sends,1);
    assert.equal((await service.list(c)).find(row => row.id===batch[0].id).delivery,'accepted');
    const blocked=await service.issueBatch(c,{ commandId: id(164),invitations: [intent('Suspended@example.com',[])] });
    await pool.query("UPDATE tenants SET status='suspended' WHERE id=$1",[id(160)]);
    assert.equal((await worker.runOnce()).status,'idle');assert.equal(sends,1);
    const state=await pool.query("SELECT status FROM customer_access_deliveries WHERE invitation_id=$1",[blocked[0].id]);
    assert.equal(state.rows[0].status,'cancelled');
    assert.equal(await auditRepository.verifyTenantChain(id(160)),true);
  });
});
