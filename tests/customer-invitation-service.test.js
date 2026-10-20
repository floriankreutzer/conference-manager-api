import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuditHarness } from './support/audit-harness.js';
import { createTenantAuditQueryService } from '../src/audit/tenant-audit-query-service.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import { createCustomerInvitationService } from '../src/application/customer-invitation-service.js';
import { createAuthorizationPolicy, tenantAuthorizationSnapshot } from '../src/authorization/policy.js';

const id = (number) => `a0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const time = '2026-10-19T12:00:00.000Z';
function context(extra = {}) {
  return { principal: { tenantId: id(1), userId: id(2), ...tenantAuthorizationSnapshot(['employee', 'tenant_admin']) },
    tenantContext: { tenantId: id(1), status: 'onboarding' }, correlationId: id(3), ...extra };
}
const intent = (extra = {}) => ({ recipient: 'person@example.com', roles: ['tenant_admin'], locale: 'de', ...extra });
const row = (extra = {}) => ({ tenantId: id(1), environment: 'int', id: id(10), revision: 1, ...intent(),
  state: 'pending', expiresAt: '2026-10-26T12:00:00.000Z', delivery: 'queued', ...extra });
function fixture(overrides = {}, auditService = null) {
  const calls = [], audits = [], denied = [];
  const repository = {
    async list(input) { calls.push(input); return [row()]; },
    async issueBatch(input) {
      calls.push(input);
      return input.invitations.map((entry, index) => {
        audits.push(input.auditEventFor({ invitationId: id(10 + index), nextRevision: 1, occurredAt: time }));
        return row({ ...entry, id: id(10 + index) });
      });
    },
    async reissue(input) {
      calls.push(input); audits.push(input.auditEventFor({ invitationId: input.invitationId, nextRevision: 2, occurredAt: time }));
      return row({ revision: 2 });
    },
    async revoke(input) { calls.push(input); return row({ revision: 2, state: 'revoked' }); },
    ...overrides,
  };
  const service = createCustomerInvitationService({ repository, authorizationPolicy: createAuthorizationPolicy(), environment: 'int',
    auditService: auditService || { createEvent: (value) => value, async recordAuthorizationDenied(value) { denied.push(value); } } });
  return { service, calls, audits, denied };
}

test('authorized invitation intent uses its Tenant and minimized audit without issuing authority', async () => {
  const f = fixture();
  const result = await f.service.issueBatch(context(), { commandId: id(50),
    invitations: [intent(), intent({ recipient: 'second@example.com', roles: [] })] });
  assert.equal(result.length, 2); assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(f.calls[0].commandId, id(50)); assert.equal(f.calls[0].tenantId, id(1));
  assert.equal(f.calls[0].environment, 'int');
  assert.equal(f.calls[0].principal.userId, id(2));
  assert.equal(f.audits[0].targetId, id(10)); assert.equal(f.audits[0].action, 'tenant.onboarding.invited');
  assert.equal(f.audits[0].metadata.operation, 'issue');
  assert.doesNotMatch(JSON.stringify(f.audits), /person@example|second@example|recipient|code|token|secret/);
  assert.doesNotMatch(JSON.stringify(result), /tenantId|userId|environment|session|delivered/);
});

test('Customer Admin permission and same-Tenant context are required before repository access', async () => {
  const f = fixture();
  for (const extra of [
    { principal: { ...context().principal, ...tenantAuthorizationSnapshot(['employee']) } },
    { principal: { ...context().principal, ...tenantAuthorizationSnapshot(['employee', 'conference_manager']) } },
    { principal: { ...context().principal, permissions: [] } },
    { principal: { ...context().principal, roles: ['platform_admin'] } },
    { tenantContext: { tenantId: id(9), status: 'onboarding' } },
    { tenantContext: { tenantId: id(1), status: 'suspended' } },
    { tenantContext: { tenantId: id(1), status: 'archived' } },
  ]) {
    for (const invoke of [() => f.service.list(context(extra)),
      () => f.service.issueBatch(context(extra), { commandId: id(50), invitations: [intent()] }),
      () => f.service.reissue(context(extra), { invitationId: id(10), expectedRevision: 1 }),
      () => f.service.revoke(context(extra), { invitationId: id(10), expectedRevision: 1 })]) await assert.rejects(invoke);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.denied.length, 24); // Four foreign-context denials have no verified audit scope.
});

test('invalid commands, revision, pagination and browser Tenant fields do not reach persistence', async () => {
  const f = fixture();
  for (const value of [{ commandId: id(50), invitations: [intent({ roles: ['platform_admin'] })] },
    { commandId: id(50), invitations: [intent()], tenantId: id(9) }, { commandId: id(50), invitations: [] }]) {
    await assert.rejects(f.service.issueBatch(context(), value));
  }
  for (const value of [{ invitationId: '../foreign', expectedRevision: 1 }, { invitationId: id(10), expectedRevision: 0 },
    { invitationId: id(10), expectedRevision: Number.MAX_SAFE_INTEGER }]) await assert.rejects(f.service.reissue(context(), value));
  for (const value of [{ limit: 101 }, { limit: 0 }, { afterInvitationId: '../foreign' }]) {
    await assert.rejects(f.service.list(context(), value));
  }
  assert.equal(f.calls.length, 0);
});

test('foreign, malformed, private and inconsistent persisted data never becomes public invitation output', async () => {
  for (const extra of [{ tenantId: id(9) }, { environment: 'prod' }, { private: 'not-public' }, { state: 'active' },
    { delivery: 'delivered' }, { roles: ['platform_admin'] }, { recipient: 'person@EXAMPLE.COM' },
    { expiresAt: '2026-10-26' }, { revision: 0 }]) {
    const f = fixture({ async list() { return [row(extra)]; } });
    await assert.rejects(f.service.list(context()));
  }
  for (const values of [[row(), row()], [row({ id: id(11) }), row()], Array(1)]) {
    await assert.rejects(fixture({ async list() { return values; } }).service.list(context()));
  }
  await assert.rejects(fixture().service.list(context(), { afterInvitationId: id(10) }));
  for (const values of [[], [row({ recipient: 'other@example.com' })], [row({ state: 'accepted' })], [row({ revision: 2 })]]) {
    await assert.rejects(fixture({ async issueBatch() { return values; } })
      .service.issueBatch(context(), { commandId: id(50), invitations: [intent()] }));
  }
});

test('reissue and revocation pass exact object/revision without accepting role or identity changes', async () => {
  const f = fixture();
  assert.equal((await f.service.reissue(context(), { invitationId: id(10), expectedRevision: 1 })).revision, 2);
  assert.equal(f.calls[0].invitationId, id(10)); assert.equal(f.calls[0].expectedRevision, 1);
  assert.equal((await f.service.revoke(context(), { invitationId: id(10), expectedRevision: 1 })).state, 'revoked');
  for (const extra of [{ id: id(11) }, { revision: 1 }, { state: 'accepted' }, { delivery: 'accepted' }]) {
    await assert.rejects(fixture({ async reissue() { return row({ revision: 2, ...extra }); } })
      .service.reissue(context(), { invitationId: id(10), expectedRevision: 1 }));
  }
});

test('persistence and required audit failures propagate without invoking outbound delivery or issuing authority', async () => {
  const failure = new Error('TEST_TRANSACTION_ROLLBACK');
  for (const method of ['issueBatch', 'reissue', 'revoke']) {
    const f = fixture({ async [method]() { throw failure; } });
    const result = method === 'issueBatch' ? f.service.issueBatch(context(), { commandId: id(50), invitations: [intent()] })
      : f.service[method](context(), { invitationId: id(10), expectedRevision: 1 });
    await assert.rejects(result, (error) => error === failure);
  }
  const f = fixture({ async issueBatch(input) {
    input.auditEventFor({ invitationId: id(10), nextRevision: 1, occurredAt: 'not-a-time' });
    return [row()];
  } });
  await assert.rejects(f.service.issueBatch(context(), { commandId: id(50), invitations: [intent()] }));
});

test('invitation conflicts expose only the fixed409 contract without private persistence context', async () => {
  const { CustomerInvitationConflictError } = await import('../src/domain/customer-invitation-errors.js');
  const { asApiError } = await import('../src/api-error.js');
  const error = new CustomerInvitationConflictError();
  assert.equal(asApiError(error).statusCode, 409);
  assert.equal(asApiError(error).code, 'CUSTOMER_INVITATION_CONFLICT');
});

test('object and session authority lost inside persistence is denied with minimized Tenant audit', async () => {
  const { AuthorizationDeniedError } = await import('../src/authorization/errors.js');
  for (const method of ['list','issueBatch','reissue','revoke']) {
    const failure = new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
    const f = fixture({ async [method]() { throw failure; } });
    const result = method === 'list' ? f.service.list(context()) : method === 'issueBatch'
      ? f.service.issueBatch(context(),{ commandId: id(50),invitations: [intent()] })
      : f.service[method](context(),{ invitationId: id(10),expectedRevision: 1 });
    await assert.rejects(result,error => error===failure);
    assert.equal(f.denied.length,1); assert.equal(f.denied[0].tenantContext.tenantId,id(1));
    assert.equal(f.denied[0].targetId, ['list','issueBatch'].includes(method) ? 'customer_invitations' : id(10));
    assert.doesNotMatch(JSON.stringify(f.denied),/person@example.com|recipient|code|token|secret/);
  }
});


test('real audit service derives invitation authority only from authenticated context', async () => {
  const audit = createAuditHarness();
  const f = fixture({}, audit.service);
  const supplied = context({ tenantId: id(90), actorUserId: id(91),
    metadata: { recipient: 'private@example.com' }, previousState: { forged: true } });
  await f.service.issueBatch(supplied, { commandId: id(50), invitations: [intent()] });
  const event = f.audits[0];
  assert.equal(event.tenantId, id(1)); assert.equal(event.actorUserId, id(2));
  assert.deepEqual(event.metadata, { operation: 'issue' });
  assert.equal(event.previousState, null);
  await f.service.reissue(supplied, { invitationId: id(10), expectedRevision: 1 });
  assert.equal(f.audits[1].tenantId, id(1)); assert.equal(f.audits[1].actorUserId, id(2));
});

test('real audit service preserves foreign-context denial without foreign evidence', async () => {
  const audit = createAuditHarness(); const f = fixture({}, audit.service);
  const foreign = context({ tenantContext: { tenantId: id(9), status: 'onboarding' } });
  for (const invoke of [() => f.service.list(foreign),
    () => f.service.issueBatch(foreign, { commandId: id(50), invitations: [intent()] }),
    () => f.service.reissue(foreign, { invitationId: id(10), expectedRevision: 1 }),
    () => f.service.revoke(foreign, { invitationId: id(10), expectedRevision: 1 })]) {
    await assert.rejects(invoke, error => error instanceof AuthorizationDeniedError
      && error.code === 'TENANT_SCOPE_INVALID' && error.conceal === false);
  }
  assert.equal(f.calls.length, 0); assert.equal(audit.events.length, 0);
  await assert.rejects(f.service.list(context({ principal: { ...context().principal,
    ...tenantAuthorizationSnapshot(['employee']) }, tenantId: id(90), actorUserId: id(91) })), AuthorizationDeniedError);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].tenantId, id(1)); assert.equal(audit.events[0].actorUserId, id(2));
  assert.equal(audit.events[0].outcome, 'denied');
});

test('Tenant-visible audit distinguishes issue, reissue and revocation without revealing recipient metadata', async () => {
  const audit = createAuditHarness();
  const f = fixture({ async revoke(input) {
    f.audits.push(input.auditEventFor({ invitationId: input.invitationId, nextRevision: 2, occurredAt: time }));
    return row({ revision: 2, state: 'revoked' });
  } }, audit.service);
  await f.service.issueBatch(context(), { commandId: id(50), invitations: [intent()] });
  await f.service.reissue(context(), { invitationId: id(10), expectedRevision: 1 });
  await f.service.revoke(context(), { invitationId: id(10), expectedRevision: 1 });
  const query = createTenantAuditQueryService({
    queryRepository: { async listByTenantId({ tenantId }) {
      assert.equal(tenantId, id(1)); return f.audits.map((event, index) => ({ ...event, id: String(3-index) }));
    } }, integrityRepository: { async verifyTenantChain(tenantId) { assert.equal(tenantId, id(1)); return true; } },
    authorizationPolicy: createAuthorizationPolicy(), auditService: audit.service, clock: () => Date.parse(time),
  });
  const page = await query.listEvents(context());
  assert.deepEqual(page.events.map(event => event.change.after), [
    { revision: 1, status: 'issued' }, { revision: 2, status: 'reissued' }, { revision: 2, status: 'revoked' },
  ]);
  assert.doesNotMatch(JSON.stringify(page), /recipient|person@example|metadata|operation|token|secret/);
});
