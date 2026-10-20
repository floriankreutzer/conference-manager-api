import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlatformCustomerInvitationAdministrationService }
  from '../src/platform/application/customer-invitation-administration-service.js';
import { PLATFORM_OPERATION } from '../src/platform/application/platform-operation-contract.js';
import { createPlatformAuthorizationPolicy,permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { normalizeCustomerInvitationBatch } from '../src/authorization/customer-invitation-policy.js';
import { projectCustomerInvitations } from '../src/application/customer-invitation-result.js';

const id=n=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=new Date().toISOString(),roles=['platform_tenant_operator'];
const principal={ operatorId: id(1),roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 1,
  providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: id(2),subjectReference: id(3) },
  targetScope: { mode: 'all',securityVersion: 1 },
  assurance: { level: 'step_up',authenticationContext: 'synthetic-proof',authenticatedAt: now },
  session: { id: id(4),securityVersion: 1,securityEpoch: 7,issuedAt: now,
    expiresAt: new Date(Date.now()+3600000).toISOString(),stepUpExpiresAt: new Date(Date.now()+120000).toISOString() } };
const intent={ recipient: 'Operator@example.test',roles: ['tenant_admin'],locale: 'de' };
const row=extra=>({ environment: 'int',tenantId: id(5),id: id(6),revision: 1,...intent,state: 'pending',
  expiresAt: '2026-10-27T12:00:00.000Z',delivery: 'queued',...extra });
const input=(operation,extra={})=>({ operatorContext: principal,tenantId: id(5),correlationId: id(7),
  idempotencyKey: id(8),reason: 'Explicit synthetic administration',confirmation: { action: operation,tenantId: id(5) },...extra });
function fixture(overrides={}) {
  const state={ reads: 0,writes: 0,evidence: [] };
  const options={ environment: 'int',platformAuthorizationPolicy: createPlatformAuthorizationPolicy(),
    tenantTargetPolicy: { async authorize(_,target){ return target===id(5); } },
    invitationContract: { normalizeBatch: normalizeCustomerInvitationBatch,projectInvitations: projectCustomerInvitations },
    operationEvidenceFactory: { async createMutation(value){ state.evidence.push(value);return {}; },
      async createSensitiveRead(value){ state.evidence.push(value);return {}; } },
    repository: { async list(value){ state.reads++;await value.evidenceFor({ occurredAt: now });return [row()]; },
      async issueBatch(value){ state.writes++;state.command=value;
        await value.evidenceFor({ invitationId: id(6),nextRevision: 1,occurredAt: now });
        return { outcome: 'updated',invitations: [row()] }; },
      async mutate(value){ state.writes++;state.command=value;
        await value.evidenceFor({ invitationId: value.invitationId,nextRevision: value.expectedRevision+1,occurredAt: now });
        return { outcome: 'updated',invitations: [row({ revision: 2,
          state: value.operation===PLATFORM_OPERATION.INVITATION_REVOKE ? 'revoked' : 'pending',
          delivery: value.operation===PLATFORM_OPERATION.INVITATION_REVOKE ? 'accepted' : 'queued' })] }; },
    },...overrides };
  return { state,options,service: createPlatformCustomerInvitationAdministrationService(options) };
}
test('Platform invitation management uses real scoped permissions, independent commands and minimized evidence',async()=>{
  const { state,service }=fixture();
  const result=await service.issueBatch(input(PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [intent] }));
  assert.equal(result.invitations[0].recipient,intent.recipient);assert.equal(state.command.tenantId,id(5));
  assert.equal(Object.hasOwn(state.command,'principal'),false);assert.equal(state.command.authorization.principal,principal);
  const revoked=await service.revoke(input(PLATFORM_OPERATION.INVITATION_REVOKE,{ invitationId: id(6),expectedRevision: 1 }));
  assert.equal(revoked.invitation.state,'revoked');assert.equal(revoked.invitation.delivery,'accepted');
  const reissued=await service.reissue(input(PLATFORM_OPERATION.INVITATION_REISSUE,{ invitationId: id(6),expectedRevision: 1 }));
  assert.equal(reissued.invitation.delivery,'queued');assert.equal(reissued.invitation.revision,2);
  assert.doesNotMatch(JSON.stringify(state.evidence),/Operator@|recipient/);
});
test('the invitation list is scoped, bounded, sorted and audited, and cannot expose private rows',async()=>{
  const { service,state }=fixture();
  const command={ operatorContext: principal,tenantId: id(5),correlationId: id(7),limit: 10,afterInvitationId: null };
  const result=await service.list(command);assert.equal(result.items.length,1);
  assert.equal(state.evidence[0].operation,PLATFORM_OPERATION.INVITATION_LIST);
  assert.equal(state.evidence[0].target.id,id(5));assert.equal(Object.hasOwn(result.items[0],'tenantId'),false);
  for (const rows of [[row({ tenantId: id(99) })],[row({ private: 'secret' })],[row(),row()],
    [row({ id: id(9) }),row()]]) {
    const f=fixture({ repository: { ...fixture().options.repository,async list(){ return rows; } } });
    await assert.rejects(f.service.list(command),/RESULT_INVALID/);
  }
  await assert.rejects(service.list({ ...command,limit: 101 }),/LIMIT_INVALID/);
  await assert.rejects(service.list({ ...command,afterInvitationId: id(6) }),/RESULT_INVALID/);
});
test('ordinary MFA, foreign targets and browser-owned scopes never reach invitation persistence',async()=>{
  const { service,state }=fixture();
  const command=input(PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [intent] });
  const ordinary={ ...principal,assurance: { ...principal.assurance,level: 'mfa' },
    session: { ...principal.session,stepUpExpiresAt: null } };
  await assert.rejects(service.issueBatch({ ...command,operatorContext: ordinary }),/STEP_UP_REQUIRED/);
  await assert.rejects(service.issueBatch({ ...command,tenantId: id(99),
    confirmation: { ...command.confirmation,tenantId: id(99) } }),/DENIED/);
  await assert.rejects(service.issueBatch({ ...command,environment: 'prod' }),/INPUT_INVALID/);
  await assert.rejects(service.issueBatch({ ...command,invitations: [{ ...intent,roles: ['platform_security_admin'] }] }),/INPUT_INVALID/);
  assert.equal(state.writes,0);
});
test('wrong mutation target/revision and changed issued intent cannot become successful public receipts',async()=>{
  for (const changed of [row({ id: id(99),revision: 2,state: 'revoked',delivery: 'cancelled' }),
    row({ revision: 3,state: 'revoked',delivery: 'cancelled' }),row({ revision: 2,state: 'revoked',delivery: 'queued' })]) {
    const base=fixture(),f=fixture({ repository: { ...base.options.repository,
      async mutate(){ return { outcome: 'updated',invitations: [changed] }; } } });
    await assert.rejects(f.service.revoke(input(PLATFORM_OPERATION.INVITATION_REVOKE,{ invitationId: id(6),expectedRevision: 1 })),
      /RESULT_INVALID/);
  }
  const base=fixture(),f=fixture({ repository: { ...base.options.repository,
    async issueBatch(){ return { outcome: 'updated',invitations: [row({ recipient: 'Other@example.test' })] }; } } });
  await assert.rejects(f.service.issueBatch(input(PLATFORM_OPERATION.TENANT_INVITATION_CREATE,{ invitations: [intent] })),/RESULT_INVALID/);
});
