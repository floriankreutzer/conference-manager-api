import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformCustomerOnboardingService } from '../src/platform/application/customer-onboarding-service.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { normalizeCustomerInvitationBatch,normalizeCustomerInvitationIntent } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';

const id=n=>`a0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner='Owner@example.test',now='2026-10-20T10:00:00.000Z';
const invitation={ recipient: 'Operator@example.test',roles: ['tenant_admin'],locale: 'en' };
function fixture(extra={}) {
  const state={ writes: 0,permissions: [],evidence: [] };
  const invitationContract={ normalizeIntent: normalizeCustomerInvitationIntent,
    normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations };
  const options={ invitationContract,environment: 'int',ownerRecipient: owner,idFactory: ()=>id(1),
    platformAuthorizationPolicy: { authorize: async (_,permission)=>{ state.permissions.push(permission);return true; } },
    tenantTargetPolicy: { authorizeCreation: async ()=>true },
    operationEvidenceFactory: { createMutation: async input=>{ state.evidence.push(input);return { accepted: true }; } },
    repository: { create: async input=>{
      state.writes++;state.input=input;
      await input.evidenceFor({ tenantId: input.proposedTenantId,occurredAt: now });
      return { outcome: 'updated',tenant: { id: id(1),displayName: input.displayName,status: 'onboarding' },
        invitations: input.invitations.map((row,index)=>({ ...row,environment: 'int',tenantId: id(1),id: id(10+index),
          revision: 1,state: 'pending',expiresAt: '2026-10-27T10:00:00.000Z',delivery: 'queued' })) };
    } },...extra };
  return { state,options,service: createPlatformCustomerOnboardingService(options) };
}
const input=extra=>({ operatorContext: { operatorId: id(2) },displayName: 'Pilot customer',reason: 'Explicit pilot onboarding',
  confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,displayName: 'Pilot customer' },
  correlationId: id(3),idempotencyKey: id(4),invitations: [invitation],...extra });

test('Platform onboarding includes the configured owner and individual operators without a Customer principal',async()=>{
  const { service,state }=fixture(),result=await service.createTenant(input());
  assert.equal(result.invitations.length,2);assert.equal(result.invitations[1].recipient,owner);
  assert.deepEqual(result.invitations[1].roles,['tenant_admin']);assert.equal(result.invitations[1].locale,'de');
  assert.equal(Object.hasOwn(state.input,'principal'),false);assert.equal(state.input.authorization.targetTenantId,null);
  assert.equal(state.evidence[0].target.type,'tenant');assert.equal(state.evidence[0].requestedState.invitationCount,2);
  assert.doesNotMatch(JSON.stringify(state.evidence),/Owner@|Operator@/);
});
test('owner-only onboarding and protected owner roles/locale remain possible without duplicate invites',async()=>{
  const { service }=fixture();assert.equal((await service.createTenant(input({ invitations: [] }))).invitations.length,1);
  const result=await service.createTenant(input({ invitations: [{ recipient: owner,roles: ['conference_manager'],locale: 'en' }] }));
  assert.equal(result.invitations.length,1);assert.deepEqual(result.invitations[0].roles,['conference_manager','tenant_admin']);
  assert.equal(result.invitations[0].locale,'de');
});
test('closed inputs and bounded invitees fail before writes, including getters and hidden authority',async()=>{
  const { service,state }=fixture();
  for (const patch of [{ invitations: [invitation,invitation] },{ invitations: Array(20).fill(invitation) },
    { invitations: [{ ...invitation,roles: ['platform_admin'] }] },{ tenantId: id(9) },
    { confirmation: { action: PLATFORM_OPERATION.TENANT_INVITATION_CREATE,displayName: 'Other' } }]) {
    await assert.rejects(service.createTenant(input(patch)),/INVALID/);
  }
  const hidden=input();Object.defineProperty(hidden,'ownerRecipient',{ value: 'Other@example.test' });
  await assert.rejects(service.createTenant(hidden),/INVALID/);
  const accessor=input();Object.defineProperty(accessor,'invitations',{ get(){ throw new Error('GETTER_EXECUTED'); },enumerable: true });
  await assert.rejects(service.createTenant(accessor),/INVALID/);assert.equal(state.writes,0);
});
test('creation scope and missing protected owner fail closed without repository effects',async()=>{
  const { service,state }=fixture({ tenantTargetPolicy: { authorizeCreation: async ()=>false } });
  await assert.rejects(service.createTenant(input()),/DENIED/);assert.equal(state.writes,0);
  const { options }=fixture();for (const ownerRecipient of [undefined,'','Name <owner@example.test>']) {
    assert.throws(()=>createPlatformCustomerOnboardingService({ ...options,ownerRecipient }),/OWNER_CONTACT_REQUIRED/);
  }
});
test('malformed repository scopes, private fields and evidence targets never become public results',async()=>{
  for (const mutate of [result=>({ ...result,private: 'secret' }),result=>({ ...result,tenant: { ...result.tenant,id: id(99) } }),
    result=>({ ...result,invitations: result.invitations.map(row=>({ ...row,tenantId: id(99) })) }),
    result=>({ ...result,invitations: result.invitations.map(row=>({ ...row,delivery: 'accepted' })) })]) {
    const base=fixture(),repository={ create: async value=>mutate(await base.options.repository.create(value)) };
    const { service }=fixture({ repository });await assert.rejects(service.createTenant(input()),/RESULT_INVALID/);
  }
  const { service }=fixture({ repository: { create: async value=>value.evidenceFor({ tenantId: id(99),occurredAt: now }) } });
  await assert.rejects(service.createTenant(input()),/UNAVAILABLE/);
});
