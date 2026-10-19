import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { normalizeCateringDeliveryJob } from '../src/domain/catering-delivery-job.js';
import { createAuditHarness } from './support/audit-harness.js';
import { cateringId as id } from './support/catering-order-fixture.js';

const context = () => ({ principal: { tenantId: id(1), userId: id(20), roles: ['conference_manager'],
  permissions: ['request:manage'], session: { id: id(21), securityVersion: 1 } },
  tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90) });
const command = () => ({ ...context(), schemaVersion: 1, orderId: id(5),
  expectedOrderVersion: 1, expectedStateRevision: 3, expectedQuoteRevision: 1 });
const job = (extra = {}) => ({ tenantId: id(1), jobId: id(6), integrationId: id(3), orderId: id(5), orderVersion: 1,
  operation: 'initial', revision: 1, status: 'queued', dispatchAttempts: 0, automaticReconciliationAttempts: 0,
  quoteRevision: 1, decisionSequence: 1, originStateRevision: 3, createdAt: '2026-10-19T12:00:00.000Z',
  updatedAt: '2026-10-19T12:00:00.000Z', availableAt: '2026-10-19T12:00:00.000Z', ...extra });
function fixture(overrides = {}) {
  const authorizationPolicy = createAuthorizationPolicy();
  const audit = createAuditHarness({ authorizationPolicy }); const calls = []; const events = [];
  const repository = {
    async load(input) { calls.push(input); return job(); },
    async list(input) { calls.push(input); return { tenantId: id(1), jobs: [job()], nextAfterJobId: null }; },
    async enqueue(input) {
      calls.push(input); events.push(input.auditEventFor({ orderId: id(5), orderVersion: 1, previousRevision: 3, revision: 4 }));
      return { status: 'enqueued', replayed: false, job: job() };
    }, ...overrides,
  };
  return { service: createCateringDeliveryService({ repository, authorizationPolicy, auditService: audit.service }), calls, events };
}

test('explicit enqueue uses trusted Manager session and minimized audit and job acknowledgement', async () => {
  const f = fixture(); const response = await f.service.enqueue(command());
  assert.equal(response.job.jobId, id(6)); assert.equal(response.replayed, false);
  assert.equal(f.calls[0].tenantId, id(1)); assert.equal(f.calls[0].actorUserId, id(20));
  assert.equal(f.calls[0].sessionId, id(21)); assert.equal(f.calls[0].expectedSecurityVersion, 1);
  assert.equal(f.events[0].action, 'catering.delivery.queued'); assert.equal(f.events[0].tenantId, id(1));
  assert.equal(f.events[0].actorUserId, id(20)); assert.equal(f.events[0].retentionClass, 'business');
  assert.deepEqual(f.events[0].newState, { revision: 4, status: 'queued', version: 1 });
  assert.doesNotMatch(JSON.stringify(response), /tenantId|sessionId|actorUserId|lease|originStateRevision|cost|providerPayload/);
  const loaded = await f.service.load({ ...context(), jobId: id(6) });
  assert.equal(loaded.job.jobId, id(6));
  const list = await f.service.list(context()); assert.equal(list.jobs.length, 1); assert.equal(list.nextAfterJobId, null);
});

test('closed durable job projection rejects private fields, accessors, mismatched source and impossible bounds', () => {
  let reads = 0;
  const accessor = Object.defineProperty(job(), 'status', { enumerable: true, get() { reads++; return 'queued'; } });
  for (const value of [accessor, job({ tenantId: id(99) }), job({ leaseId: id(9) }), job({ operation: 'change' }),
    job({ orderVersion: 2 }), job({ status: 'succeeded' }), job({ dispatchAttempts: 4 }), job({ revision: 0 }),
    job({ automaticReconciliationAttempts: 11 }), job({ availableAt: null }), job({ availableAt: 'invalid' }),
    job({ updatedAt: '2026-10-18T12:00:00.000Z' }), job({ quoteRevision: Number.MAX_SAFE_INTEGER })]) {
    assert.throws(() => normalizeCateringDeliveryJob(value, { tenantId: id(1), jobId: id(6) }));
  }
  assert.equal(reads, 0);
});

test('Employee, technical Admin, absent permission, inactive Tenant and missing live session fail before repository', async () => {
  const f = fixture();
  for (const role of ['employee','tenant_admin','platform_admin']) {
    const value = command(); value.principal.roles = [role];
    assert.equal(asApiError(await f.service.enqueue(value).catch((error) => error)).statusCode, 403);
  }
  const missing = command(); missing.principal.permissions = [];
  await assert.rejects(f.service.enqueue(missing));
  const inactive = command(); inactive.tenantContext.status = 'suspended'; await assert.rejects(f.service.enqueue(inactive));
  const noSession = command(); delete noSession.principal.session; await assert.rejects(f.service.enqueue(noSession));
  assert.deepEqual(f.calls, []);
});

test('input counters and source identity fail before writes and foreign/missing results conceal existence', async () => {
  const f = fixture();
  for (const extra of [{ schemaVersion: 2 }, { orderId: 'external' }, { expectedOrderVersion: 0 },
    { expectedStateRevision: Number.MAX_SAFE_INTEGER - 1 }, { expectedQuoteRevision: -1 }]) {
    assert.equal(asApiError(await f.service.enqueue({ ...command(), ...extra }).catch((error) => error)).statusCode, 400);
  }
  assert.deepEqual(f.calls, []);
  for (const method of ['load','list','enqueue']) {
    const malicious = fixture({ [method]: async () => method === 'list'
      ? { tenantId: id(99), jobs: [job()], nextAfterJobId: null }
      : method === 'enqueue' ? { status: 'enqueued', replayed: false, job: job({ tenantId: id(99) }) } : job({ tenantId: id(99) }) });
    await assert.rejects(malicious.service[method]({ ...command(), jobId: id(6) }));
  }
  const absent = fixture({ load: async () => null, enqueue: async () => ({ status: 'not_found' }) });
  assert.equal(asApiError(await absent.service.load({ ...context(), jobId: id(6) }).catch((error) => error)).statusCode, 404);
  assert.equal(asApiError(await absent.service.enqueue(command()).catch((error) => error)).statusCode, 404);
});

test('conflicts are explicit and not retried; invalid committed acknowledgements never become success', async () => {
  for (const status of ['state_conflict','order_conflict','already_enqueued','approval_unavailable']) {
    let calls = 0;
    const f = fixture({ enqueue: async () => { calls++; return { status }; } });
    assert.equal(asApiError(await f.service.enqueue(command()).catch((error) => error)).statusCode, 409);
    assert.equal(calls, 1);
  }
  for (const extra of [{ originStateRevision: 2 }, { orderVersion: 2, operation: 'change' }, { quoteRevision: 2 },
    { dispatchAttempts: 1 }, { revision: 2 }]) {
    const f = fixture({ enqueue: async () => ({ status: 'enqueued', replayed: false, job: job(extra) }) });
    await assert.rejects(f.service.enqueue(command()), /INVALID/);
  }
  const replay = fixture({ enqueue: async () => ({ status: 'enqueued', replayed: true,
    job: job({ status: 'deferred', revision: 2, availableAt: null }) }) });
  const response = await replay.service.enqueue(command()); assert.equal(response.replayed, true);
  assert.equal(response.job.status, 'deferred');
});

test('read pages reject duplicates, backwards cursors, overlarge pages and unrelated order filters', async () => {
  for (const page of [{ tenantId: id(1), jobs: [job(),job()], nextAfterJobId: null },
    { tenantId: id(1), jobs: [job()], nextAfterJobId: id(6) },
    { tenantId: id(1), jobs: Array.from({ length: 21 }, () => job()), nextAfterJobId: null }]) {
    await assert.rejects(fixture({ list: async () => page }).service.list(context()), /INVALID/);
  }
  await assert.rejects(fixture().service.list({ ...context(), afterJobId: id(7) }), /INVALID/);
  await assert.rejects(fixture().service.list({ ...context(), orderId: id(99) }), /INVALID/);
});
