import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerEmailAdmissionService } from '../src/identity/customer-email-admission-service.js';
import { createAuditHarness } from './support/audit-harness.js';

const id = number => `f1000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
test('closed membership choice cannot introduce Tenant, role, actor or provider authority', async () => {
  let calls = 0,reads = 0;
  const audit = createAuditHarness();
  const service = createCustomerEmailAdmissionService({ repository: { async choices() {},async admit() { calls++; } },
    auditService: audit.service,sessionService: { async issue() {} } });
  const context = { challengeId: id(1),browserToken: 'synthetic',csrfToken: 'synthetic',correlationId: id(2) };
  const accessor = {}; Object.defineProperty(accessor,'membershipId',{ enumerable: true,get() { reads++; return id(3); } });
  for (const command of [null,[],{},accessor,Object.create({ membershipId: id(3) }),{ membershipId: id(3),tenantId: id(4) },
    { membershipId: id(3),roles: ['tenant_admin'] },{ membershipId: id(3),actorUserId: id(4) },{ membershipId: '../foreign' }]) {
    await assert.rejects(service.select(context,command),/ADMISSION_INPUT_INVALID/);
  }
  assert.equal(calls,0); assert.equal(reads,0);
});
test('admission audit uses the production validator and fixed server event semantics', async () => {
  const audit = createAuditHarness(); const events = [];
  const service = createCustomerEmailAdmissionService({ repository: { async choices() {},async admit(input) {
    events.push(input.auditEventFor({ kind: 'provision',tenantId: id(4),userId: id(5),occurredAt: '2026-10-19T12:00:00.000Z' }));
    events.push(input.auditEventFor({ kind: 'accept',tenantId: id(4),userId: id(5),invitationId: id(6),revision: 2,
      occurredAt: '2026-10-19T12:00:00.000Z' }));
    return { status: 'rejected' };
  } },auditService: audit.service,sessionService: { async issue() { throw new Error('NO_IDENTITY_WITHOUT_REPOSITORY'); } } });
  await service.select({ challengeId: id(1).toUpperCase(),correlationId: id(2).toUpperCase(),
    tenantId: id(90),actorUserId: id(91) },{ membershipId: id(3) });
  assert.equal(events[0].tenantId,id(4)); assert.equal(events[0].actorUserId,id(5)); assert.equal(events[0].correlationId,id(2));
  assert.deepEqual(events[0].metadata,{ provider: 'email_code',source: 'invitation' });
  assert.equal(events[1].targetId,id(6)); assert.deepEqual(events[1].metadata,{ operation: 'accept' });
  assert.deepEqual(events[1].newState,{ revision: 2 });
});
