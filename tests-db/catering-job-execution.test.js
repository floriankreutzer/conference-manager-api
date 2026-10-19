import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, loadDatabaseConfig } from '../src/config.js';
import { createCustomerComposition } from '../src/customer-composition.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createCateringDeliveryService } from '../src/application/catering-delivery-service.js';
import { createCateringJobProcessor } from '../src/application/catering-job-processor.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresCateringDeliveryRepository } from '../src/persistence/postgres/catering-delivery-repository.js';
import { createPostgresCateringJobRepository } from '../src/persistence/postgres/catering-job-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import { createProviderRegistry } from '../src/integrations/provider-registry.js';
import { CateringDeliveryError } from '../src/integrations/catering-contract.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { migrateDemoUp } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

test('actual Customer execution retains intent, lease recovery, safe retry facts and normalized receipts across restarts', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test', ...database, databasePoolMax: 6 });
  let runtime = null;
  const roles = Object.fromEntries(['customer','platform','reset'].map((key) => [key, `cm_execution_${key}_${process.pid}`]));
  t.after(async () => {
    try { await runtime?.stop(); }
    finally {
      try {
        for (const role of Object.values(roles)) await pool.query(`DROP OWNED BY "${role}"`);
        for (const role of Object.values(roles)) await pool.query(`DROP ROLE "${role}"`);
      } finally { await pool.end(); }
    }
  });
  for (const role of Object.values(roles)) await pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const customer = {
    async connect() {
      const client = await pool.connect();
      return { async query(query, values) {
        const answer = await client.query(query, values);
        if (typeof query === 'string' && query.startsWith('BEGIN ')) await client.query(`SET LOCAL ROLE "${roles.customer}"`);
        return answer;
      }, release(error) { client.release(error); } };
    },
    query(query, values) { return withPostgresTransaction(customer, (client) => client.query(query, values)); },
  };
  const manual = createCateringConfigurationRegistry();
  // Controlled descriptor/adapter simulation, never a production API registration
  // or evidence of a qualified live supplier. Disable via real Admin CAS before
  // changing the synthetic descriptor, then enable via the same real repository.
  const api = createProviderRegistry({ runtime: 'production', descriptors: [{ id: 'manual_catering', runtime: 'production',
    capabilities: { 'catering.order': 'api', 'catering.status': 'api' } }] });
  let currentRegistry = manual; let mode = 'manual';
  const registry = { get: (providerId) => currentRegistry.get(providerId) };
  const fixture = await createCateringDeliveryFixture(pool, { registry, extraCount: 1 });
  const delivery = createCateringDeliveryService({ authorizationPolicy: createAuthorizationPolicy(), auditService: fixture.auditService,
    repository: createPostgresCateringDeliveryRepository(customer, { registry, auditRepository: fixture.auditRepository }) });
  async function switchMode(next) {
    if (mode === next) return;
    await fixture.setOrderCapability(false);
    currentRegistry = next === 'api' ? api : manual; mode = next;
    await fixture.setOrderCapability(true, mode);
  }
  async function enqueue(sequence, options) {
    await switchMode('manual');
    const view = await fixture.createApprovedOrder(sequence, options);
    return (await delivery.enqueue({ ...fixture.context(), schemaVersion: 1, orderId: view.order.orderId,
      expectedOrderVersion: 1, expectedStateRevision: 3, expectedQuoteRevision: 1 })).job;
  }
  const make = (auditRepository = fixture.auditRepository, leaseMs = 30000) => createPostgresCateringJobRepository(customer,
    { registry, auditRepository, auditService: fixture.auditService, leaseMs });
  let replies = ['confirmed','confirmed']; let writeFailure = null; let writes = 0; let reads = 0;
  const provider = {
    async placeOrder(input) {
      writes++; if (writeFailure) throw writeFailure;
      return { orderId: input.orderId, orderVersion: input.orderVersion,
        positions: input.order.positions.map((position, index) => ({ positionId: position.positionId, outcome: replies[index] })) };
    },
    async readOrderStatus(input) {
      reads++; assert.equal(Object.hasOwn(input, 'order'), false); assert.equal(Object.hasOwn(input, 'quote'), false);
      const positions = await pool.query(`SELECT position_id FROM catering_order_positions
        WHERE tenant_id=$1 AND order_id=$2 AND version=$3 ORDER BY position_id`, [input.tenantId,input.orderId,input.orderVersion]);
      return { orderId: input.orderId, orderVersion: input.orderVersion,
        positions: positions.rows.map((position) => ({ positionId: position.position_id, outcome: 'confirmed' })) };
    },
  };
  const run = (repository = make()) => createCateringJobProcessor({ repository, registry, jitter: () => 0,
    providers: { resolve: () => provider } }).runBatch({ limit: 1, signal: new AbortController().signal });
  const state = async (job) => (await pool.query('SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2',
    [id(1),job.jobId])).rows[0];
  const business = async (job) => (await fixture.orders.load({ ...fixture.context(), orderId: job.orderId })).state.status;
  const manualJob = await enqueue(0); assert.equal((await run()).deferredCount, 1);
  assert.equal((await state(manualJob)).status, 'deferred'); assert.equal(writes, 0);
  assert.equal((await state(manualJob)).dispatch_attempts, 0); assert.equal(await business(manualJob), 'queued');

  const confirmed = await enqueue(1); await switchMode('api');
  assert.equal((await run()).completedCount, 1); assert.equal(await business(confirmed), 'confirmed');
  assert.equal((await state(confirmed)).dispatch_attempts, 1);
  const partial = await enqueue(2); await switchMode('api'); replies = ['confirmed','rejected'];
  assert.equal((await run()).completedCount, 1); assert.equal(await business(partial), 'partially_confirmed');
  const pending = await enqueue(3); await switchMode('api'); replies = ['pending','pending'];
  assert.equal((await run()).completedCount, 1); assert.equal(await business(pending), 'transmitted');

  const crash = await enqueue(4); await switchMode('api');
  const oldProcess = make(fixture.auditRepository, 2000); const lease = await oldProcess.claimNext();
  assert.equal(lease.job.jobId, crash.jobId); await oldProcess.beginDispatch(lease);
  await new Promise((resolve) => setTimeout(resolve, 2100)); // Actual DB lease expiry after committed intent.
  const restarted = make(); const recovered = await restarted.claimNext();
  assert.equal(recovered.kind, 'reconcile'); assert.notEqual(recovered.leaseId, lease.leaseId);
  assert.equal(recovered.job.dispatchAttempts, 1);
  const observed = { lease: { ...lease, attempt: 1 }, outcome: 'unknown', retryable: false, failureCode: 'timeout',
    receipt: null, status: 'reconciliation_required', delayMs: 60000 };
  assert.equal(await oldProcess.finish(observed), 'obsolete');
  // A new processor consumes the already durable read lease without another claim.
  let first = true;
  const resumed = { ...restarted, async claimNext() { if (!first) return null; first = false; return recovered; } };
  const writesBefore = writes; assert.equal((await run(resumed)).completedCount, 1);
  assert.equal(writes, writesBefore); assert.equal(reads, 1); assert.equal(await business(crash), 'confirmed');

  const retry = await enqueue(5); await switchMode('api');
  writeFailure = new CateringDeliveryError('unavailable', { outcome: 'not_sent', retryable: true });
  assert.equal((await run()).deferredCount, 1); assert.equal(await business(retry), 'failed');
  assert.equal((await state(retry)).status, 'retry_wait');
  await new Promise((resolve) => setTimeout(resolve, 1100)); // Actual persisted retry due time.
  writeFailure = null; replies = ['confirmed','confirmed'];
  assert.equal((await run()).completedCount, 1); assert.equal(await business(retry), 'confirmed');
  assert.equal((await state(retry)).dispatch_attempts, 2);
  const expiringAt = new Date(Date.now() + 10000).toISOString();
  const expiring = await enqueue(6, { quoteExpiresAt: expiringAt }); await switchMode('api');
  const expiringLease = await make().claimNext(); const intent = await make().beginDispatch(expiringLease);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiringAt) - Date.now()) + 100));
  assert.equal(await make().finish({ lease: { ...expiringLease, attempt: intent.attempt }, outcome: 'not_sent', retryable: true,
    failureCode: 'unavailable', receipt: null, status: 'retry_wait', delayMs: 0 }), 'retry_wait');
  assert.equal(await business(expiring), 'failed');
  const beforeExpiredRetry = writes;
  assert.equal((await run()).deferredCount, 1); assert.equal(writes, beforeExpiredRetry);
  assert.equal((await state(expiring)).status, 'deferred');
  assert.equal((await state(expiring)).dispatch_attempts, 1);

  const atomic = await enqueue(7); await switchMode('api');
  const unavailableAudit = { async appendWithClient() { throw new Error('SYNTHETIC_AUDIT_UNAVAILABLE'); } };
  await assert.rejects(make(unavailableAudit).claimNext(), /SYNTHETIC_AUDIT_UNAVAILABLE/);
  assert.equal((await state(atomic)).status, 'queued');
  const atomicLease = await make().claimNext();
  await assert.rejects(make(unavailableAudit).beginDispatch(atomicLease), /SYNTHETIC_AUDIT_UNAVAILABLE/);
  assert.equal((await state(atomic)).status, 'leased'); assert.equal((await state(atomic)).dispatch_attempts, 0);
  let atomicFirst = true;
  const atomicPort = { ...make(), async claimNext() { if (!atomicFirst) return null; atomicFirst = false; return atomicLease; } };
  assert.equal((await run(atomicPort)).completedCount, 1); assert.equal(await business(atomic), 'confirmed');
  assert.equal((await state(atomic)).dispatch_attempts, 1);
  const startupJob = await enqueue(8); // Restore the actual production manual descriptor.
  const config = { ...loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://localhost:3000',
    CATERING_ORDERS_ENABLED: 'true', CATERING_DELIVERY_ENABLED: 'true' }), ...database, mode: 'test',
    port: 0, host: '127.0.0.1', auditHmacSecret: 'a'.repeat(32), csrfSecret: 'c'.repeat(32), oidcTransactionSecret: 'o'.repeat(32) };
  const storage = createPostgresPersistence(config); let storageClosed = false;
  async function closeStorage() { if (!storageClosed) { storageClosed = true; await storage.close(); } }
  t.after(closeStorage);
  let calendarCalls = 0;
  const forbiddenCalendar = () => { calendarCalls++; throw new Error('SYNTHETIC_CALENDAR_OPERATION_FORBIDDEN'); };
  const microsoft365Client = Object.fromEntries(['lookupFreeBusy','adminConsentUrl','verifyBasePermissions','discoverRooms']
    .map((method) => [method, forbiddenCalendar]));
  runtime = createCustomerComposition({ config, microsoft365Client, persistence: { ...storage, pool: customer,
    auditRepository: fixture.auditRepository, close: closeStorage }, logger: {
    lifecycle() {}, requestCompleted() {}, healthEvaluated() {}, securityOutcome() {}, unhandledError() {},
  } });
  t.after(() => runtime.stop());
  await runtime.start();
  const deadline = Date.now() + 5000;
  while ((await state(startupJob)).status !== 'deferred' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await state(startupJob)).status, 'deferred');
  assert.equal((await state(startupJob)).dispatch_attempts, 0);
  await runtime.stop(); assert.equal(storageClosed, true);
  assert.equal(calendarCalls, 0);
  assert.equal(await fixture.auditRepository.verifyTenantChain(id(1)), true);
});
