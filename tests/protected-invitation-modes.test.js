import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { tenantAuthorizationSnapshot } from '../src/authorization/policy.js';
import { createPostgresCustomerInvitationRepository } from '../src/persistence/postgres/customer-invitation-repository.js';
import { isPostgresTransactionActive } from '../src/persistence/postgres/transaction.js';

const tenantId=randomUUID(),principal={ tenantId,userId: randomUUID(),...tenantAuthorizationSnapshot(['employee','tenant_admin']),
  providerIdentity: { provider: 'email_code',reference: randomUUID() },session: { id: randomUUID(),securityVersion: 1,
    issuedAt: new Date().toISOString(),expiresAt: new Date(Date.now()+3_600_000).toISOString() } };
function fixture(allowed) {
  const queries=[];let sealed=0,opened=0,audits=0,qualifications=0;
  const client={ async query(query) { queries.push(query);if (typeof query==='object') throw new Error('CANONICAL_ACTOR_REQUIRED'); },
    release() {} };
  const pool={ async connect() { return client; } };
  const repository=createPostgresCustomerInvitationRepository(pool,{ environment: 'int',
    cipher: { seal() { sealed++; },open() { opened++; },recipientLookup: ()=>'r'.repeat(64),commandDigest: ()=>'d'.repeat(64) },
    content: { invitation() { throw new Error('NO_MAIL_CONTENT_BEFORE_REAL'); } },
    auditRepository: { appendWithClient() { audits++; } },
    tenantEligibility: { async allowsWithClient(value,id) {
      assert.equal(value,client);assert.equal(isPostgresTransactionActive(pool,value),true);assert.equal(id,tenantId);
      qualifications++;return allowed;
    } } });
  return { repository,queries,observed: ()=>({ sealed,opened,audits,qualifications }) };
}
const commands={
  list: { limit: 50,afterInvitationId: null },
  issueBatch: { commandId: randomUUID(),invitations: [{ recipient: 'Invited@example.test',locale: 'de',roles: ['tenant_admin'] }] },
  reissue: { invitationId: randomUUID(),expectedRevision: 1 },
  revoke: { invitationId: randomUUID(),expectedRevision: 1 },
};

test('invitation reads, batches, resend and revoke require strict REAL before actor locks or custody',async()=>{
  for (const allowed of [false,null,undefined,1,'true']) {
    const f=fixture(allowed);
    for (const [method,command] of Object.entries(commands)) await assert.rejects(f.repository[method]({ ...command,
      environment: 'int',tenantId,principal,correlationId: randomUUID() }),/RESOURCE_NOT_AVAILABLE/);
    assert.deepEqual(f.observed(),{ sealed: 0,opened: 0,audits: 0,qualifications: 4 });
    assert.equal(f.queries.filter(query=>typeof query==='object').length,0);
  }
});

test('REAL qualification never replaces current actor, role, session, receipt or object checks',async()=>{
  const f=fixture(true);
  for (const [method,command] of Object.entries(commands)) await assert.rejects(f.repository[method]({ ...command,
    environment: 'int',tenantId,principal,correlationId: randomUUID() }),/CANONICAL_ACTOR_REQUIRED/);
  assert.deepEqual(f.observed(),{ sealed: 0,opened: 0,audits: 0,qualifications: 4 });
  assert.equal(f.queries.filter(query=>query?.name==='customer-invitation-tenant-lock').length,4);
});
