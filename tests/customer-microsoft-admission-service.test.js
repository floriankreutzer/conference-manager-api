import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerMicrosoftAdmissionService } from '../src/identity/customer-microsoft-admission-service.js';
import { createAuditService } from '../src/audit/audit-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
const id=n=>`b5000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const context={ flowId: id(1),browserToken: 'B'.repeat(43),csrfToken: 'c'.repeat(64),correlationId: id(2) };
function fixture() {
  const calls=[];
  const repository=Object.fromEntries(['choices','admit','linkConfirmation','confirmLink','accountState'].map(method=>[method,async input=>{
    calls.push({ method,input });return { status: 'rejected' };
  }]));
  const auditRepository=Object.fromEntries(['append','listByTenantId','verifyTenantChain'].map(method=>[method,async()=>{
    throw new Error('UNEXPECTED_NONATOMIC_AUDIT');
  }]));
  const auditService=createAuditService({ repository: auditRepository,
    authorizationPolicy: createAuthorizationPolicy() });
  const sessionService={ async issue(identity,options) {
    calls.push({ method: 'session',identity,options });return { setCookie: 'synthetic' };
  } };
  return { calls,service: createCustomerMicrosoftAdmissionService({ repository,auditService,sessionService }) };
}
test('explicit selection supplies only membership intent and delegates ordinary session issuance with server correlation',async()=>{
  const f=fixture();await f.service.select(context,{ membershipId: id(3) });
  const call=f.calls[0];assert.equal(call.method,'admit');assert.equal(call.input.membershipId,id(3));
  const identity=Object.freeze({ tenantId: id(4),userId: id(5) });await call.input.issueSession(identity);
  assert.equal(f.calls[1].identity,identity);assert.deepEqual(f.calls[1].options,{ correlationId: id(2) });
});
test('link confirmation generates minimized server-derived identity-change audit with version invalidation',async()=>{
  const f=fixture(),principal=Object.freeze({ sentinel: true });
  await f.service.confirmLink({ ...context,principal },{ confirm: true });
  const call=f.calls[0];assert.equal(call.method,'confirmLink');assert.equal(call.input.principal,principal);
  const event=call.input.auditEventFor({ tenantId: id(4),userId: id(5),correlationId: id(6),
    occurredAt: '2026-10-20T12:00:00.000Z',previousSecurityVersion: 7,securityVersion: 8 });
  assert.equal(event.action,'tenant.user.identity_linked');assert.equal(event.actorUserId,id(5));assert.equal(event.correlationId,id(6));
  assert.deepEqual(event.previousState,{ securityVersion: 7 });assert.deepEqual(event.newState,{ securityVersion: 8 });
  assert.deepEqual(event.metadata,{ provider: 'microsoft_entra',source: 'explicit_link' });
  assert.doesNotMatch(JSON.stringify(event),/email|mailbox|browser|nonce|csrf|sessionId|providerUser/);
  assert.throws(()=>call.input.auditEventFor({ tenantId: id(4),userId: id(5),correlationId: id(6),
    occurredAt: '2026-10-20T12:00:00.000Z',previousSecurityVersion: 7,securityVersion: 7 }),/INPUT_INVALID/);
});
test('browser-provided Tenant, role, provider claim, audit identity or implicit confirmation cannot reach repository custody',()=>{
  const f=fixture();
  for (const command of [{},{ membershipId: id(3),tenantId: id(4) },{ membershipId: id(3),roles: ['tenant_admin'] },
    { membershipId: id(3),provider: 'microsoft_entra' }]) assert.throws(()=>f.service.select(context,command),/INPUT_INVALID/);
  for (const command of [{},{ confirm: false },{ confirm: true,email: 'Untrusted@example.test' },
    { confirm: true,userId: id(5) }]) assert.throws(()=>f.service.confirmLink({ ...context,principal: null },command),/INPUT_INVALID/);
  assert.throws(()=>f.service.select({ ...context,tenantId: id(4) },{ membershipId: id(3) }),/INPUT_INVALID/);
  const accessor=Object.defineProperty({},'membershipId',{ enumerable: true,get() { throw new Error('DO_NOT_EXECUTE'); } });
  assert.throws(()=>f.service.select(context,accessor),/INPUT_INVALID/);assert.equal(f.calls.length,0);
});
test('read ceremonies preserve explicit browser custody and reject added primary identity input',async()=>{
  const f=fixture();await f.service.choices({ flowId: id(1),browserToken: context.browserToken });
  await f.service.linkConfirmation({ flowId: id(1),browserToken: context.browserToken,principal: null });
  assert.deepEqual(f.calls.map(call=>call.method),['choices','linkConfirmation']);
  assert.throws(()=>f.service.choices({ flowId: id(1),browserToken: context.browserToken,identity: {} }),/INPUT_INVALID/);
});
test('personal link state accepts only the authenticated server principal and no caller-selected account',async()=>{
  const f=fixture(),principal=Object.freeze({ sentinel: true });await f.service.accountState({ principal });
  assert.equal(f.calls[0].method,'accountState');assert.equal(f.calls[0].input.principal,principal);
  assert.throws(()=>f.service.accountState({ principal,userId: id(5) }),/INPUT_INVALID/);assert.equal(f.calls.length,1);
});
