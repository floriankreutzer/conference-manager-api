import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringOrderService } from '../src/application/catering-order-service.js';
import { CateringOrderConflictError } from '../src/application/catering-order-errors.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id, cateringOrderFixture } from './support/catering-order-fixture.js';

const context = () => ({ principal: { tenantId: id(1), userId: id(20), roles: ['conference_manager'],
  permissions: ['request:manage'], session: { id: id(21), securityVersion: 1 } },
tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(22) });

function fixture() {
  const [snapshot] = createCateringOrderSnapshots(cateringOrderFixture());
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy });
  const view = { tenantId: id(1), snapshot, providerId: 'manual_catering', configurationRevision: 1, operation: 'initial',
    state: { revision: 1, status: 'pending_quote', updatedAt: '2026-10-19T10:00:00.000Z' }, quote: null, decision: null };
  const calls = [];
  const events = [];
  const reference = () => ({ orderId: snapshot.orderId, integrationId: snapshot.integrationId, version: 1,
    stateRevision: view.state.revision, status: view.state.status });
  const repository = {
    async load(input) { calls.push({ method: 'load', input }); return view; },
    async list(input) { calls.push({ method: 'list', input }); return { tenantId: id(1), items: [reference()], nextAfterOrderId: null }; },
    async prepare(input) {
      calls.push({ method: 'prepare', input });
      events.push(input.auditEventFor({ orderId: snapshot.orderId, version: 1, previousRevision: 0, revision: 1,
        status: 'pending_quote', requestVersion: 2, assignmentRevision: 3, catalogueRevision: 4,
        configurationRevision: 1, positionCount: 1 }));
      return { status: 'prepared', tenantId: id(1), replayed: false, orders: [reference()] };
    },
    async recordQuote(input) {
      calls.push({ method: 'quote', input });
      const previous = view.state.revision;
      view.state = { revision: previous + 1, status: 'pending_manager_review', updatedAt: input.changedAt.toISOString() };
      view.quote = { revision: input.expectedQuoteRevision + 1, cost: input.cost, expiresAt: input.expiresAt, expired: false };
      view.decision = null;
      events.push(input.auditEventFor({ orderId: snapshot.orderId, version: view.snapshot.orderVersion, previousRevision: previous,
        revision: view.state.revision, status: view.state.status, quoteRevision: view.quote.revision,
        amountMinor: input.cost.amountMinor, currency: input.cost.currency }));
      return { status: 'quoted', current: view };
    },
    async decide(input) {
      calls.push({ method: 'decide', input });
      const previous = view.state.revision;
      view.state = { revision: previous + 1, status: input.decision === 'approved' ? 'released' : 'rejected',
        updatedAt: input.changedAt.toISOString() };
      view.decision = { sequence: 1, decision: input.decision, quoteRevision: view.quote.revision, cost: view.quote.cost,
        deciderUserId: input.actorUserId, securityVersion: input.expectedSecurityVersion };
      events.push(input.auditEventFor({ orderId: snapshot.orderId, version: view.snapshot.orderVersion, previousRevision: previous,
        revision: view.state.revision, status: view.state.status, quoteRevision: view.quote.revision,
        amountMinor: view.quote.cost.amountMinor, currency: view.quote.cost.currency, decision: input.decision }));
      return { status: 'decided', current: view };
    },
  };
  const make = (overrides = {}) => createCateringOrderService({ repository, registry: createCateringConfigurationRegistry(),
    authorizationPolicy, auditService: audit.service, clock: () => Date.parse('2026-10-19T10:00:00.000Z'), ...overrides });
  const prepare = () => ({ ...context(), schemaVersion: 1, requestId: 'request-a', commandId: id(23),
    expectedRequestVersion: 2, expectedAssignmentRevision: 3 });
  const quote = () => ({ ...context(), schemaVersion: 1, orderId: snapshot.orderId, expectedStateRevision: view.state.revision,
    expectedQuoteRevision: view.quote?.revision ?? 0, cost: { amountMinor: 1200, currency: 'EUR' },
    expiresAt: '2026-10-20T10:00:00.000Z' });
  const decide = (decision = 'approved') => ({ ...context(), schemaVersion: 1, orderId: snapshot.orderId,
    expectedStateRevision: view.state.revision, expectedQuoteRevision: view.quote?.revision ?? 1, decision });
  return { make, service: make(), repository, view, snapshot, calls, events, prepare, quote, decide };
}

test('first physical replacement DTO explicitly retains business review and exact v2 quote/decision approval', async () => {
  const f = fixture(); f.view.snapshot = { ...f.snapshot, orderVersion: 2 };
  f.view.operation = 'change'; f.view.deliveryOperation = 'initial';
  const loaded = await f.service.load({ ...context(), orderId: f.snapshot.orderId, orderVersion: 2 });
  assert.equal(loaded.schemaVersion, 2); assert.equal(loaded.deliveryOperation, 'initial');
  assert.equal(loaded.operation, 'change'); assert.equal(loaded.order.orderVersion, 2);
  assert.equal(Object.hasOwn(loaded.order, 'tenantId'), false);
  const quoted = await f.service.recordQuote({ ...f.quote(), expectedOrderVersion: 2 });
  assert.equal(quoted.state.status, 'pending_manager_review'); assert.equal(quoted.schemaVersion, 2);
  const approved = await f.service.decide({ ...f.decide(), expectedOrderVersion: 2 });
  assert.equal(approved.state.status, 'released'); assert.equal(approved.decision.cost.amountMinor, 1200);
  assert.equal(approved.deliveryOperation, 'initial');
  for (const extra of [{ deliveryOperation: 'change' }, { operation: 'initial' }, { operation: 'cancel' },
    { snapshot: f.snapshot }, { deliveryOperation: 'unknown' }]) {
    const invalid = fixture(); invalid.view.snapshot = { ...invalid.snapshot, orderVersion: 2 };
    Object.assign(invalid.view, { operation: 'change', deliveryOperation: 'initial' }, extra);
    await assert.rejects(invalid.service.load({ ...context(), orderId: invalid.snapshot.orderId }), /RESULT_INVALID/);
  }
  const old = fixture();
  const initial = await old.service.load({ ...context(), orderId: old.snapshot.orderId });
  assert.equal(initial.schemaVersion, 1); assert.equal(Object.hasOwn(initial, 'deliveryOperation'), false);
});

test('Manager prepares, records exact supplier cost and decides through independent revisions and minimized server audit', async () => {
  const f = fixture();
  const prepared = await f.service.prepare(f.prepare());
  assert.equal(prepared.orders[0].status, 'pending_quote');
  const quoted = await f.service.recordQuote(f.quote());
  assert.equal(quoted.quote.revision, 1);
  assert.equal(quoted.state.revision, 2);
  assert.equal(quoted.order.providerCost, null);
  const decided = await f.service.decide(f.decide());
  assert.equal(decided.state.status, 'released');
  assert.equal(decided.state.revision, 3);
  assert.equal(decided.decision.quoteRevision, 1);
  assert.equal(Object.hasOwn(decided.decision, 'deciderUserId'), false);
  assert.equal(Object.hasOwn(decided.order, 'tenantId'), false);
  assert.equal(Object.hasOwn(decided.order, 'requesterUserId'), false);
  assert.deepEqual(f.events.map((event) => event.action), ['catering.order.prepared','catering.order.quoted','catering.order.decided']);
  for (const event of f.events) {
    assert.equal(event.tenantId, id(1)); assert.equal(event.actorUserId, id(20)); assert.equal(event.correlationId, id(22));
    assert.equal(event.retentionClass, 'business'); assert.equal(event.targetId, f.snapshot.orderId);
    assert.equal(JSON.stringify(event).includes('Synthetic dietary'), false);
    assert.equal(JSON.stringify(event).includes('Synthetic Requester'), false);
  }
  for (const call of f.calls) {
    assert.equal(call.input.tenantId, id(1));
    if (call.method !== 'load' && call.method !== 'list') {
      assert.equal(call.input.actorUserId, id(20)); assert.equal(call.input.sessionId, id(21));
      assert.equal(call.input.expectedSecurityVersion, 1);
    }
  }
});

test('Admin, Employee, unknown Manager permissions, foreign Tenant and non-active lifecycle cannot reach order ports', async () => {
  for (const principal of [
    { ...context().principal, roles: ['employee'], permissions: ['request:read'] },
    { ...context().principal, roles: ['tenant_admin'], permissions: ['tenant:integrations:manage'] },
    { ...context().principal, roles: ['tenant_admin'] }, { ...context().principal, permissions: [] },
    { ...context().principal, tenantId: id(9) },
  ]) {
    const f = fixture();
    for (const invoke of [() => f.service.load({ ...context(), principal, orderId: f.snapshot.orderId }),
      () => f.service.list({ ...context(), principal }), () => f.service.prepare({ ...f.prepare(), principal }),
      () => f.service.recordQuote({ ...f.quote(), principal }), () => f.service.decide({ ...f.decide(), principal })]) {
      await assert.rejects(invoke());
    }
    assert.deepEqual(f.calls, []);
  }
  for (const status of ['pending','onboarding','ready','suspended','archived']) {
    const f = fixture();
    await assert.rejects(f.service.prepare({ ...f.prepare(), tenantContext: { tenantId: id(1), status } }));
    assert.deepEqual(f.calls, []);
  }
});

test('session, positive schema, revisions, money and quote instants fail before privileged writes', async () => {
  for (const change of [{ schemaVersion: 2 }, { commandId: 'external' }, { requestId: '../other' },
    { expectedRequestVersion: 0 }, { expectedAssignmentRevision: 0 },
    { principal: { ...context().principal, session: undefined } }]) {
    const f = fixture(); await assert.rejects(f.service.prepare({ ...f.prepare(), ...change })); assert.deepEqual(f.calls, []);
  }
  for (const change of [{ schemaVersion: 2 }, { expectedStateRevision: 0 }, { expectedQuoteRevision: -1 },
    { cost: { amountMinor: 1, currency: 'EUR', approved: true } }, { expiresAt: 'tomorrow' }]) {
    const f = fixture(); await assert.rejects(f.service.recordQuote({ ...f.quote(), ...change })); assert.deepEqual(f.calls, []);
  }
});

test('transaction-time revocation, failed audit and all known conflicts never become a successful acknowledgement or retry', async () => {
  for (const value of [{ status: 'not_authorized' }, { status: 'not_found' }, { status: 'request_conflict' },
    { status: 'assignment_conflict' }, { status: 'already_prepared' }, { status: 'connection_unavailable' },
    { status: 'no_catering' }, { status: 'state_conflict', currentRevision: 0 }, { status: 'unexpected' }]) {
    const f = fixture(); let calls = 0;
    const service = f.make({ repository: { ...f.repository, prepare: async () => { calls++; return value; } } });
    await assert.rejects(service.prepare(f.prepare()));
    assert.equal(calls, 1);
  }
  const f = fixture();
  const service = f.make({ repository: { ...f.repository, prepare: async () => { throw new Error('SYNTHETIC_AUDIT_FAILURE'); } } });
  await assert.rejects(service.prepare(f.prepare()), /SYNTHETIC_AUDIT_FAILURE/);
  const error = asApiError(new CateringOrderConflictError('CATERING_ORDER_REVISION_CONFLICT', 0));
  assert.equal(error.statusCode, 409); assert.deepEqual(error.context, { currentRevision: 0 });
  assert.throws(() => new CateringOrderConflictError('SQL_PRIVATE_ERROR'));
});

test('foreign or malformed port results and different quote/decision acknowledgements cannot be exposed', async () => {
  for (const mutate of [(v) => { v.tenantId = id(9); }, (v) => { v.snapshot = { ...v.snapshot, tenantId: id(9) }; },
    (v) => { v.state.status = 'delivered'; }, (v) => { v.privateData = 'forbidden'; },
    (v) => { v.providerId = 'unknown'; }]) {
    const f = fixture(); const value = structuredClone(f.view); mutate(value);
    const service = f.make({ repository: { ...f.repository, load: async () => value } });
    await assert.rejects(service.load({ ...context(), orderId: f.snapshot.orderId }));
  }
  const f = fixture();
  const service = f.make({ repository: { ...f.repository, recordQuote: async () => ({ status: 'quoted', current: f.view }) } });
  await assert.rejects(service.recordQuote(f.quote()));
  await f.service.recordQuote(f.quote());
  const wrongActor = f.make({ repository: { ...f.repository, decide: async (input) => {
    const saved = await f.repository.decide(input); saved.current.decision.deciderUserId = id(99); return saved;
  } } });
  await assert.rejects(wrongActor.decide(f.decide()));
});

test('collection reads are bounded, strictly scoped and reject corrupt or inaccessible cursors', async () => {
  const f = fixture();
  const page = await f.service.list(context());
  assert.equal(page.orders.length, 1); assert.equal(page.nextAfterOrderId, null);
  for (const pageValue of [{ tenantId: id(9), items: [], nextAfterOrderId: null },
    { tenantId: id(1), items: [], nextAfterOrderId: id(8) },
    { tenantId: id(1), items: Array(21).fill({}), nextAfterOrderId: null }]) {
    const service = f.make({ repository: { ...f.repository, list: async () => pageValue } });
    await assert.rejects(service.list(context()));
  }
});

test('quote and decision bind an explicit order version while legacy writes remain scoped to initial version one', async () => {
  const legacy = fixture(); await legacy.service.recordQuote(legacy.quote());
  assert.equal(legacy.calls.at(-1).input.expectedOrderVersion, 1);
  const next = fixture(); next.view.snapshot = { ...next.snapshot, orderVersion: 2 };
  await next.service.recordQuote({ ...next.quote(), expectedOrderVersion: 2 });
  assert.equal(next.calls.at(-1).input.expectedOrderVersion, 2);
  await next.service.decide({ ...next.decide(), expectedOrderVersion: 2 });
  assert.equal(next.calls.at(-1).input.expectedOrderVersion, 2);
  assert.deepEqual(next.events.map((event) => event.newState.version), [2,2]);
  for (const expectedOrderVersion of [0, '2', Number.MAX_SAFE_INTEGER]) {
    const f = fixture();
    await assert.rejects(f.service.recordQuote({ ...f.quote(), expectedOrderVersion })); assert.equal(f.calls.length, 0);
    await assert.rejects(f.service.decide({ ...f.decide(), expectedOrderVersion })); assert.equal(f.calls.length, 0);
  }
});

test('a same-revision response from another order version cannot acknowledge a quote or decision', async () => {
  const quote = fixture(); quote.view.snapshot = { ...quote.snapshot, orderVersion: 2 };
  await assert.rejects(quote.service.recordQuote(quote.quote()), /CATERING_ORDER_RESULT_INVALID/);
  const decision = fixture(); decision.view.snapshot = { ...decision.snapshot, orderVersion: 2 };
  await decision.service.recordQuote({ ...decision.quote(), expectedOrderVersion: 2 });
  await assert.rejects(decision.service.decide(decision.decide()), /CATERING_ORDER_RESULT_INVALID/);
});

test('historical order reads cannot receive another version from the persistence port', async () => {
  const f = fixture(); assert.equal((await f.service.load({ ...context(), orderId: f.snapshot.orderId, orderVersion: 1 }))
    .order.orderVersion, 1);
  assert.equal(f.calls.at(-1).input.orderVersion, 1);
  await assert.rejects(f.service.load({ ...context(), orderId: f.snapshot.orderId, orderVersion: 2 }), /INVALID/);
  await assert.rejects(f.service.load({ ...context(), orderId: f.snapshot.orderId, orderVersion: 0 }));
});
