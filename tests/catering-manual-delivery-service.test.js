import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringManualDeliveryService } from '../src/application/catering-manual-delivery-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const context = () => ({ principal: { tenantId: id(1), userId: id(20), roles: ['conference_manager'],
  permissions: ['request:manage'], session: { id: id(21), securityVersion: 1 } },
  tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90) });
const command = () => ({ ...context(), orderId: id(5), schemaVersion: 1, commandId: id(6),
  expectedOrderVersion: 1, expectedStateRevision: 4, kind: 'transmitted', channel: 'telephone',
  reference: 'Synthetic conversation #1', occurredAt: '2026-10-19T13:00:00.000Z', receipt: null });
const receipt = () => ({ orderId: id(5), orderVersion: 1, positions: [{ positionId: id(7), outcome: 'confirmed' }] });
const fact = (sequence = 1, extra = {}) => ({ tenantId: id(1), orderId: id(5), orderVersion: 1, sequence, commandId: id(6),
  originStateRevision: sequence + 3, kind: sequence === 1 ? 'transmitted' : 'receipt', channel: 'telephone',
  reference: 'Synthetic conversation #1', occurredAt: '2026-10-19T13:00:00.000Z', recordedAt: '2026-10-19T14:00:00.000Z',
  actorUserId: id(20), actorSecurityVersion: 1, quoteRevision: 1, decisionSequence: 1, operation: 'initial',
  status: sequence === 1 ? 'transmitted' : 'confirmed', receipt: sequence === 1 ? null : receipt(), ...extra });
const page = (events = [fact()], sequence = 1, next = null) => ({ tenantId: id(1), orderId: id(5), orderVersion: 1,
  orderState: { orderVersion: 1, revision: 4 + sequence, status: sequence === 1 ? 'transmitted' : 'confirmed' },
  manualSequence: sequence, events, nextAfterSequence: next, effective: null });
function fixture(overrides = {}) {
  const authorizationPolicy = createAuthorizationPolicy(); const audit = createAuditHarness({ authorizationPolicy });
  const calls = []; const events = [];
  const repository = { async load(value) { calls.push(value); return page(); },
    async record(value) {
      calls.push(value); events.push(value.auditEventFor({ orderId: id(5), orderVersion: 1, sequence: 1,
        previousRevision: 4, revision: 5, previousStatus: 'queued', status: 'transmitted', kind: 'transmitted' }));
      return { status: 'recorded', replayed: false, fact: fact(), orderState: page().orderState };
    }, ...overrides };
  return { calls, events, service: createCateringManualDeliveryService({ repository, authorizationPolicy, auditService: audit.service }) };
}

test('manual factual command binds Manager/session and minimizes attestation audit', async () => {
  const f = fixture(); const saved = await f.service.record(command());
  assert.equal(saved.fact.kind, 'transmitted'); assert.equal(saved.orderState.status, 'transmitted');
  assert.equal(f.calls[0].tenantId, id(1)); assert.equal(f.calls[0].actorUserId, id(20));
  assert.equal(f.calls[0].sessionId, id(21)); assert.equal(f.calls[0].expectedSecurityVersion, 1);
  assert.equal(f.events[0].action, 'catering.manual.transmitted'); assert.equal(f.events[0].actorUserId, id(20));
  assert.deepEqual(f.events[0].newState, { revision: 5, status: 'transmitted', version: 1 });
  assert.doesNotMatch(JSON.stringify(f.events[0]), /Synthetic conversation|telephone|reference|positions|supplierCost/);
  assert.doesNotMatch(JSON.stringify(saved), /tenantId|commandId|originStateRevision|actorUserId|actorSecurityVersion|sessionId/);
  const loaded = await f.service.load({ ...context(), orderId: id(5) });
  assert.equal(loaded.manualSequence, 1); assert.equal(loaded.events[0].reference, command().reference);
  assert.equal(loaded.effective, null);
  assert.doesNotMatch(JSON.stringify(loaded), /tenantId|commandId|actorUserId|actorSecurityVersion|sessionId/);
});

test('manual service cannot give Employee, technical Admin, foreign Tenant or stale session write authority', async () => {
  const f = fixture();
  for (const role of ['employee','tenant_admin','platform_admin']) {
    const value = command(); value.principal.roles = [role];
    assert.equal(asApiError(await f.service.record(value).catch((error) => error)).statusCode, 403);
  }
  const foreign = command(); foreign.tenantContext.tenantId = id(99);
  await assert.rejects(f.service.record(foreign));
  const missing = command(); missing.principal.permissions = []; await assert.rejects(f.service.record(missing));
  const session = command(); delete session.principal.session; await assert.rejects(f.service.record(session));
  const inactive = command(); inactive.tenantContext.status = 'suspended'; await assert.rejects(f.service.record(inactive));
  assert.equal(f.calls.length, 0);
});

test('manual input, scope, receipt and bounded reference errors fail before repository writes', async () => {
  const f = fixture();
  for (const extra of [{ schemaVersion: 2 }, { orderId: 'foreign' }, { expectedStateRevision: Number.MAX_SAFE_INTEGER },
    { channel: 'automatic' }, { reference: 'https://synthetic.invalid' }, { reference: '<script>' },
    { kind: 'receipt', receipt: { ...receipt(), cost: 1200 } }, { kind: 'transmitted', receipt: receipt() }]) {
    assert.equal(asApiError(await f.service.record({ ...command(), ...extra }).catch((error) => error)).statusCode, 400);
  }
  assert.equal(f.calls.length, 0);
  const absent = fixture({ load: async () => null, record: async () => ({ status: 'not_found' }) });
  assert.equal(asApiError(await absent.service.load({ ...context(), orderId: id(5) }).catch((error) => error)).statusCode, 404);
  assert.equal(asApiError(await absent.service.record(command()).catch((error) => error)).statusCode, 404);
});

test('manual conflicts are explicit and never retried; malformed or foreign acknowledgements cannot appear successful', async () => {
  for (const status of ['state_conflict','command_conflict','approval_unavailable','manual_source_unavailable',
    'already_transmitted','transmission_required','terminal_conflict','time_conflict','receipt_conflict']) {
    let calls = 0; const f = fixture({ record: async () => { calls++; return { status }; } });
    assert.equal(asApiError(await f.service.record(command()).catch((error) => error)).statusCode, 409); assert.equal(calls, 1);
  }
  for (const extra of [{ tenantId: id(99) }, { commandId: id(99) }, { originStateRevision: 3 }, { reference: 'changed' },
    { actorUserId: id(99) }, { kind: 'receipt', receipt: receipt(), status: 'confirmed' }]) {
    const f = fixture({ record: async () => ({ status: 'recorded', replayed: false,
      fact: fact(1, extra), orderState: page().orderState }) });
    await assert.rejects(f.service.record(command()), /INVALID/);
  }
  const replay = fixture({ record: async () => ({ status: 'recorded', replayed: true, fact: fact(),
    orderState: { orderVersion: 1, revision: 8, status: 'confirmed' } }) });
  assert.equal((await replay.service.record(command())).replayed, true);
});

test('manual history keysets require complete bounded contiguous pages and a positively minimized effective version', async () => {
  const full = page(Array.from({ length: 20 }, (_, index) => fact(index + 1)), 21, 20);
  assert.equal((await fixture({ load: async () => full }).service.load({ ...context(), orderId: id(5) })).events.length, 20);
  const tail = { ...page([fact(21)], 21), effective: { orderVersion: 1, status: 'confirmed' } };
  const loaded = await fixture({ load: async () => tail }).service.load({ ...context(), orderId: id(5), afterSequence: 20 });
  assert.equal(loaded.events[0].sequence, 21); assert.equal(loaded.nextAfterSequence, null); assert.equal(loaded.effective.orderVersion, 1);
  for (const corrupt of [{ ...full, events: [...full.events].reverse() }, { ...full, events: full.events.slice(1) },
    { ...full, nextAfterSequence: 19 }, { ...full, tenantId: id(99) }, { ...full, events: [...full.events, fact(21)] },
    { ...page(), effective: { orderVersion: 1, status: 'transmitted' } }, { ...page(), events: [fact(1, { actorPayload: 'private' })] }]) {
    await assert.rejects(fixture({ load: async () => corrupt }).service.load({ ...context(), orderId: id(5) }), /INVALID/);
  }
});
