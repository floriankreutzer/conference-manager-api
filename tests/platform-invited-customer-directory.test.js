import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPlatformTenantOperationsRepository } from '../src/persistence/postgres/platform-operations-repository.js';

const id=n=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=new Date('2026-10-20T12:00:00.000Z');
const record=(extra={})=>({ tenant_id: id(1),display_name: 'Invited pilot',lifecycle_status: 'onboarding',lifecycle_revision: 1,
  tenant_updated_at: now,invitation_id: id(2),invitation_revision: 1,invitation_expires_at: new Date(now.getTime()+86400000),
  consumed_at: null,revoked_at: null,binding_status: null,claim_pending: false,snapshot_at: now,...extra });
const authorization={ targetAuthorization: { mode: 'all',operatorId: id(3),securityVersion: 1 } };
const query={ lifecycleStatus: null,search: null,cursor: null,limit: 10 };
function fixture(environment=null,rows=[record()]) {
  const calls=[];
  const pool={ async connect(){ throw new Error('UNEXPECTED_CONNECTION'); },async query(value){
    calls.push(value);return value.name==='platform-directory-snapshot-clock'
      ? { rows: [{ snapshot_at: now }] } : { rows };
  } };
  const audit={ appendWithClient(){} },onboardingRepository={ findInvitationByTenantId(){},createTenantInvitationWithClient(){},
    revokeInvitationWithClient(){},reissueInvitationWithClient(){} };
  const tenantLifecycleRepository={ findLifecycleById(){},changeStatusWithClient(){} };
  const options={ tenantAuditRepository: audit,platformAuditRepository: audit,onboardingRepository,
    tenantLifecycleRepository,cursorSecret: 's'.repeat(48),customerInvitationEnvironment: environment };
  return { calls,pool,options,reader: createPostgresPlatformTenantOperationsRepository(pool,options).directoryReader };
}
test('real invitation directory selects environment-bound custody without decrypting recipients or inventing legacy claims',async()=>{
  const f=fixture('int'),result=await f.reader.list({ query,authorization });
  const sql=f.calls.at(-1);assert.equal(sql.name,'platform-tenant-directory-invited-page');
  assert.equal(sql.values[8],'int');assert.match(sql.text,/FROM customer_member_invitations/);
  assert.match(sql.text,/AND environment=\$9/);assert.match(sql.text,/member\.environment=\$9/);
  assert.doesNotMatch(sql.text,/tenant_onboarding_invitations|tenant_claim_transactions|recipient_envelope|lookup_hash/);
  assert.equal(result.items[0].onboardingState,'invited');assert.equal(result.items[0].invitationState,'open');
  assert.equal(result.items[0].identityState,'pending');assert.doesNotMatch(JSON.stringify(result),/recipient|mailbox|provider/);
});
test('email membership acceptance is claimed while Microsoft directory identity remains independently pending',async()=>{
  const f=fixture('int',[record({ customer_member_accepted: true })]);
  const row=(await f.reader.list({ query,authorization })).items[0];
  assert.equal(row.onboardingState,'claimed');assert.equal(row.identityState,'pending');assert.equal(row.invitationState,'open');
  const consumed=fixture('int',[record({ customer_member_accepted: true,consumed_at: now })]);
  assert.equal((await consumed.reader.list({ query,authorization })).items[0].invitationState,'consumed');
});
test('legacy directory SQL, eight parameters and state semantics remain unchanged by the optional mode',async()=>{
  const f=fixture(),result=await f.reader.list({ query,authorization });const sql=f.calls.at(-1);
  assert.equal(sql.name,'platform-tenant-directory-page');assert.equal(sql.values.length,8);
  assert.match(sql.text,/FROM tenant_onboarding_invitations/);assert.match(sql.text,/FROM tenant_claim_transactions/);
  assert.doesNotMatch(sql.text,/customer_access_memberships|customer_member_invitations/);
  assert.equal(result.items[0].onboardingState,'invited');
});
test('directory cursor cannot cross environment or legacy mode, and unknown protected configuration fails closed',async()=>{
  const f=fixture('int',[record(),record({ tenant_id: id(4) })]);
  const result=await f.reader.list({ query: { ...query,limit: 1 },authorization });assert.ok(result.nextCursor);
  for (const mode of ['prod',null]) {
    const other=fixture(mode);
    await assert.rejects(other.reader.list({ query: { ...query,limit: 1,cursor: result.nextCursor },authorization }),
      /CURSOR/);assert.equal(other.calls.length,0);
  }
  assert.throws(()=>fixture('demo'),/ENVIRONMENT_INVALID/);
  await assert.rejects(f.reader.list({ query,authorization: null }),/AUTHORIZATION_INVALID/);
});
