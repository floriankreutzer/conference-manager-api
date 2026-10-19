import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringVersionService } from '../src/application/catering-version-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';
import { versionContext, versionCommand, versionProposal, versionPage } from './support/catering-version-fixture.js';

function fixture(overrides = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy });
  const calls = []; const events = [];
  const repository = { async load(value) { calls.push(value); return versionPage(); },
    async propose(value) {
      calls.push(value); events.push(value.auditEventFor({ orderId: id(5), orderVersion: 2, priorOrderVersion: 1,
        priorStateRevision: 6, basisOrderVersion: 1, requestVersion: 2, sourceRequestVersion: 2, operation: 'change' }));
      return { status: 'proposed', replayed: false, proposal: versionProposal(),
        orderState: { orderVersion: 2, revision: 1, status: 'pending_quote' } };
    }, ...overrides };
  return { calls, events, service: createCateringVersionService({ repository, authorizationPolicy, auditService: audit.service }) };
}

test('version proposal binds Manager/session/epoch and audits source versions without justification or private data', async () => {
  const f = fixture(); const saved = await f.service.propose(versionCommand());
  assert.equal(f.calls[0].tenantId, id(1)); assert.equal(f.calls[0].actorUserId, id(20));
  assert.equal(f.calls[0].sessionId, id(21)); assert.equal(f.calls[0].expectedSecurityVersion, 1);
  assert.equal(saved.proposal.orderVersion, 2); assert.equal(saved.proposal.sourceRequestVersion, 2);
  assert.equal(saved.orderState.status, 'pending_quote'); assert.equal(Object.isFrozen(saved.proposal), true);
  assert.doesNotMatch(JSON.stringify(saved), /tenantId|commandId|priorStateRevision|proposedByUserId|proposerSecurityVersion|sessionId/);
  assert.equal(f.events[0].action, 'catering.order.version_proposed'); assert.equal(f.events[0].actorUserId, id(20));
  assert.deepEqual(f.events[0].previousState, { version: 1, revision: 6 });
  assert.deepEqual(f.events[0].newState, { version: 2, revision: 1, status: 'pending_quote' });
  assert.doesNotMatch(JSON.stringify(f.events[0]), /Synthetic changed|justification|positions|supplierPayload|sessionId/);
  const page = await f.service.load({ ...versionContext(), orderId: id(5) });
  assert.deepEqual(page.allowedOperations, ['change','cancel']); assert.equal(page.basis.orderVersion, 1);
});

test('Employee, technical Admin, foreign Tenant, inactive Tenant and stale session cannot reach version persistence', async () => {
  const f = fixture();
  for (const role of ['employee','tenant_admin','platform_admin']) {
    const value = versionCommand(); value.principal.roles = [role];
    assert.equal(asApiError(await f.service.propose(value).catch((error) => error)).statusCode, 403);
    await assert.rejects(f.service.load({ ...value, orderId: id(5) }));
  }
  const foreign = versionCommand(); foreign.tenantContext.tenantId = id(99); await assert.rejects(f.service.propose(foreign));
  const inactive = versionCommand(); inactive.tenantContext.status = 'suspended'; await assert.rejects(f.service.propose(inactive));
  const session = versionCommand(); delete session.principal.session; await assert.rejects(f.service.propose(session));
  assert.equal(f.calls.length, 0);
});

test('version command validation and hidden resources fail without writes; known conflicts never retry', async () => {
  const f = fixture();
  for (const extra of [{ orderId: 'foreign' }, { schemaVersion: 2 }, { expectedOrderVersion: Number.MAX_SAFE_INTEGER },
    { expectedRequestVersion: 0 }, { expectedAssignmentRevision: '2' }, { operation: 'initial' },
    { justification: '' }, { justification: 'line\nbreak' }, { justification: 'x'.repeat(1001) }]) {
    assert.equal(asApiError(await f.service.propose({ ...versionCommand(), ...extra }).catch((error) => error)).statusCode, 400);
  }
  await assert.rejects(f.service.load({ ...versionContext(), orderId: id(5), afterOrderVersion: 0 }));
  assert.equal(f.calls.length, 0);
  const missing = fixture({ load: async () => null, propose: async () => ({ status: 'not_found' }) });
  assert.equal(asApiError(await missing.service.load({ ...versionContext(), orderId: id(5) }).catch((error) => error)).statusCode, 404);
  assert.equal(asApiError(await missing.service.propose(versionCommand()).catch((error) => error)).statusCode, 404);
  for (const status of ['state_conflict','command_conflict','request_conflict','assignment_conflict','source_unavailable']) {
    let count = 0; const conflict = fixture({ propose: async () => { count++; return { status }; } });
    assert.equal(asApiError(await conflict.service.propose(versionCommand()).catch((error) => error)).statusCode, 409);
    assert.equal(count, 1);
  }
});

test('version acknowledgments enforce exact source command, actor, operation and fresh versus replayed states', async () => {
  for (const extra of [{ tenantId: id(99) }, { commandId: id(99) }, { priorStateRevision: 5 }, { proposedByUserId: id(99) },
    { proposerSecurityVersion: 2 }, { assignmentRevision: 3 }, { justification: 'Changed text' }, { requestEvidenceVersion: 3 }]) {
    const f = fixture({ propose: async () => ({ status: 'proposed', replayed: false, proposal: versionProposal(2, extra),
      orderState: { orderVersion: 2, revision: 1, status: 'pending_quote' } }) });
    await assert.rejects(f.service.propose(versionCommand()), /INVALID/);
  }
  const wrongState = fixture({ propose: async () => ({ status: 'proposed', replayed: false, proposal: versionProposal(),
    orderState: { orderVersion: 2, revision: 2, status: 'released' } }) });
  await assert.rejects(wrongState.service.propose(versionCommand()), /INVALID/);
  const replay = fixture({ propose: async () => ({ status: 'proposed', replayed: true, proposal: versionProposal(),
    orderState: { orderVersion: 2, revision: 6, status: 'confirmed' } }) });
  assert.equal((await replay.service.propose(versionCommand())).replayed, true);
});

test('version history enforces complete20/21 pages and cannot advertise unsafe replacement/cancellation authority', async () => {
  const full = versionPage(Array.from({ length: 20 }, (_, index) => versionProposal(index + 2)), 22, 21);
  const loaded = await fixture({ load: async () => full }).service.load({ ...versionContext(), orderId: id(5) });
  assert.equal(loaded.proposals.length, 20); assert.equal(loaded.nextAfterOrderVersion, 21);
  const tail = versionPage([versionProposal(22)], 22);
  assert.equal((await fixture({ load: async () => tail }).service.load({ ...versionContext(), orderId: id(5), afterOrderVersion: 21 }))
    .proposals.length, 1);
  for (const corrupt of [{ ...full, proposals: full.proposals.slice(1) }, { ...full, proposals: [...full.proposals].reverse() },
    { ...full, nextAfterOrderVersion: 20 }, { ...versionPage(), allowedOperations: ['change','change'] },
    { ...versionPage(), allowedOperations: ['exception'] }, { ...versionPage(), currentRequest: null },
    { ...versionPage(), basis: { ...versionPage().basis, status: 'cancelled' } },
    { ...versionPage(), orderState: { orderVersion: 1, revision: 6, status: 'reconciliation_required' } },
    { ...full, proposals: [versionProposal(2, { requestId: 'another-request' }), ...full.proposals.slice(1)] }]) {
    await assert.rejects(fixture({ load: async () => corrupt }).service.load({ ...versionContext(), orderId: id(5) }), /INVALID/);
  }
});
