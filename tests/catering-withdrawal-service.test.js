import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringWithdrawalService } from '../src/application/catering-withdrawal-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';
import { versionContext as context } from './support/catering-version-fixture.js';

const command = () => ({ ...context(), orderId: id(5), schemaVersion: 1, commandId: id(7),
  expectedOrderVersion: 1, expectedStateRevision: 3, justification: 'Synthetic local withdrawal', attestNotTransmitted: true });
const fact = (extra = {}) => ({ tenantId: id(1), orderId: id(5), orderVersion: 1, commandId: id(7), originStateRevision: 3,
  previousStatus: 'released', quoteRevision: 1, decisionSequence: 1, jobId: null, jobRevision: null,
  justification: 'Synthetic local withdrawal', attestNotTransmitted: true, recordedAt: '2026-10-19T16:00:00.000Z', actorUserId: id(20),
  actorSecurityVersion: 1, ...extra });
const page = (extra = {}) => ({ tenantId: id(1), orderId: id(5), orderState: { orderVersion: 1, revision: 3, status: 'released' },
  eligible: true, effective: null, withdrawal: null, ...extra });
const ack = (extra = {}) => ({ status: 'withdrawn', replayed: false, withdrawal: fact(),
  orderState: { orderVersion: 1, revision: 4, status: 'withdrawn' }, ...extra });
function fixture(overrides = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy });
  const calls = []; const events = [];
  const repository = { async load(input) { calls.push(input); return page(); }, async withdraw(input) {
    calls.push(input); events.push(input.auditEventFor({ orderId: id(5), orderVersion: 1,
      previousRevision: 3, revision: 4, previousStatus: 'released' })); return ack();
  }, ...overrides };
  return { calls, events, service: createCateringWithdrawalService({ repository, authorizationPolicy, auditService: audit.service }) };
}
test('withdrawal binds the live Manager epoch, minimizes the fact and audits a local stop without costs or justification', async () => {
  const f = fixture(); const saved = await f.service.withdraw(command());
  assert.equal(f.calls[0].tenantId, id(1)); assert.equal(f.calls[0].actorUserId, id(20));
  assert.equal(f.calls[0].sessionId, id(21)); assert.equal(f.calls[0].expectedSecurityVersion, 1);
  assert.equal(saved.orderState.status, 'withdrawn'); assert.equal(Object.isFrozen(saved.withdrawal), true);
  assert.doesNotMatch(JSON.stringify(saved), /tenantId|commandId|actorUserId|actorSecurityVersion|jobId|sessionId|quoteRevision/);
  assert.equal(f.events[0].action, 'catering.order.withdrawn');
  assert.deepEqual(f.events[0].newState, { version: 1, revision: 4, status: 'withdrawn' });
  assert.doesNotMatch(JSON.stringify(f.events[0]), /Synthetic local|justification|amountMinor|sessionId/);
  const available = await f.service.load({ ...context(), orderId: id(5) }); assert.equal(available.eligible, true);
  const historical = fixture({ load: async () => page({ eligible: false, withdrawal: fact(), orderState: saved.orderState,
    effective: { orderVersion: 2, status: 'confirmed' } }) });
  assert.equal((await historical.service.load({ ...context(), orderId: id(5), orderVersion: 1 })).withdrawal.previousStatus, 'released');
});
test('withdrawal rejects foreign Tenant, non-Manager, inactive Tenant, missing session and malformed commands', async () => {
  const f = fixture();
  for (const role of ['employee','tenant_admin','platform_admin']) {
    const value = command(); value.principal.roles = [role];
    assert.equal(asApiError(await f.service.withdraw(value).catch((error) => error)).statusCode, 403);
    await assert.rejects(f.service.load(value));
  }
  const foreign = command(); foreign.tenantContext.tenantId = id(99); await assert.rejects(f.service.withdraw(foreign));
  const suspended = command(); suspended.tenantContext.status = 'suspended'; await assert.rejects(f.service.withdraw(suspended));
  const stale = command(); delete stale.principal.session; await assert.rejects(f.service.withdraw(stale));
  for (const extra of [{ orderId: 'foreign' }, { schemaVersion: 2 }, { expectedOrderVersion: 0 },
    { expectedStateRevision: Number.MAX_SAFE_INTEGER - 1 }, { attestNotTransmitted: false }, { justification: '' },
    { justification: 'x\ny' }]) {
    assert.equal(asApiError(await f.service.withdraw({ ...command(), ...extra }).catch((error) => error)).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
});
test('hidden resources, conflicts, unsafe eligibility and mismatched withdrawal acknowledgements fail without retry', async () => {
  for (const status of ['state_conflict','command_conflict','source_unavailable','not_found','not_authorized']) {
    let calls = 0; const f = fixture({ withdraw: async () => { calls++; return { status }; } });
    const expected = status === 'not_found' ? 404 : status === 'not_authorized' ? 403 : 409;
    assert.equal(asApiError(await f.service.withdraw(command()).catch((error) => error)).statusCode, expected); assert.equal(calls, 1);
  }
  for (const value of [page({ tenantId: id(99) }), page({ orderState: { orderVersion: 1, revision: 3, status: 'confirmed' } }),
    page({ effective: { orderVersion: 1, status: 'confirmed' } }), page({ withdrawal: fact() }),
    page({ eligible: false, orderState: { orderVersion: 1, revision: 4, status: 'withdrawn' } })]) {
    await assert.rejects(fixture({ load: async () => value }).service.load({ ...context(), orderId: id(5) }), /INVALID/);
  }
  for (const extra of [{ tenantId: id(99) }, { orderId: id(99) }, { actorUserId: id(99) }, { actorSecurityVersion: 2 },
    { commandId: id(99) }, { justification: 'Changed' }, { originStateRevision: 2 }, { previousStatus: 'confirmed' },
    { jobId: id(8) }, { recordedAt: 'invalid' }]) {
    await assert.rejects(fixture({ withdraw: async () => ack({ withdrawal: fact(extra) }) }).service.withdraw(command()), /INVALID/);
  }
  for (const extra of [{ replayed: 'true' }, { orderState: { orderVersion: 1, revision: 5, status: 'withdrawn' } },
    { orderState: { orderVersion: 1, revision: 4, status: 'cancelled' } }]) {
    await assert.rejects(fixture({ withdraw: async () => ack(extra) }).service.withdraw(command()), /INVALID/);
  }
  assert.equal((await fixture({ withdraw: async () => ack({ replayed: true }) }).service.withdraw(command())).replayed, true);
});
