import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool, isPostgresSchemaReady } from '../src/persistence/postgres/pool.js';
import { createPostgresDemoResetRepository } from '../src/persistence/postgres/demo-reset-repository.js';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM } from '../src/demo/fixture.js';
import { migrateUp, rollbackLatest } from '../scripts/db-migrations.mjs';
import { migrateDemoUp, rollbackLatestDemoMigration } from '../scripts/demo-db-migrations.mjs';
import { createCateringDeliveryFixture } from './support/catering-delivery-fixture.js';
import { cateringId as id } from '../tests/support/catering-order-fixture.js';

test('delivery schema fences actual Customer leases, immutable attempts and exact normalized observations', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const admin = createPostgresPool({ mode: 'test', ...database });
  const name = `conference_manager_demo_delivery_${process.pid}`;
  const roles = Object.fromEntries(['customer','platform','reset'].map((surface) => [surface, `cm_delivery_${surface}_${process.pid}`]));
  let pool;
  t.after(async () => {
    try {
      await pool?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    } finally { await admin.end(); }
  });
  await admin.query(`CREATE DATABASE "${name}"`);
  for (const role of Object.values(roles)) await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
  const url = new URL(database.databaseUrl); url.pathname = `/${name}`;
  pool = createPostgresPool({ mode: 'test', ...database, databaseUrl: url.toString(), databasePoolMax: 6 });
  await migrateUp(pool); assert.equal(await isPostgresSchemaReady(pool), true);
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual facts schema050.
  assert.equal(await rollbackLatest(pool), true); assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  const fixture = await createCateringDeliveryFixture(pool);
  const view = await fixture.createApprovedOrder();
  const tenantId = fixture.tenantId; const orderId = view.order.orderId; const jobId = id(1000);
  const privileges = await pool.query(`SELECT
    has_table_privilege($1,'catering_delivery_jobs','UPDATE') AS job_update,
    has_table_privilege($1,'catering_delivery_attempts','INSERT') AS attempt_insert,
    has_table_privilege($1,'catering_delivery_attempts','UPDATE') AS attempt_update,
    has_table_privilege($1,'catering_delivery_observations','INSERT') AS observation_insert,
    has_table_privilege($1,'catering_delivery_observations','DELETE') AS observation_delete,
    has_table_privilege($2,'catering_delivery_jobs','SELECT') AS platform_read,
    has_table_privilege($3,'catering_delivery_observations','TRUNCATE') AS reset_truncate,
    has_function_privilege($1,'verify_catering_delivery_heads()','EXECUTE') AS direct_verification`,
  [roles.customer, roles.platform, roles.reset]);
  assert.deepEqual(privileges.rows[0], { job_update: true, attempt_insert: true, attempt_update: false,
    observation_insert: true, observation_delete: false, platform_read: false, reset_truncate: true, direct_verification: false });
  async function roleTransaction(role, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE "${role}"`);
      const result = await work(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const customer = (work) => roleTransaction(roles.customer, work);
  await assert.rejects(roleTransaction(roles.platform, (client) => client.query('SELECT * FROM catering_delivery_jobs')),
    (error) => error.code === '42501');
  const insert = (client, change = {}) => client.query(`INSERT INTO catering_delivery_jobs
    (tenant_id,id,integration_id,provider_id,order_id,order_version,operation,quote_revision,decision_sequence,
      origin_state_revision,revision,status,dispatch_attempts,reconciliation_attempts,available_at,created_by_user_id,correlation_id)
    VALUES ($1,$2,$3,'manual_catering',$4,1,'initial',$5,1,3,1,'queued',0,0,clock_timestamp(),$6,$7)`,
  [change.tenantId ?? tenantId, change.jobId ?? jobId, change.integrationId ?? fixture.integrationId, change.orderId ?? orderId,
    change.quoteRevision ?? 1, id(20), id(90)]);
  await assert.rejects(customer((client) => insert(client)), /CURRENT_APPROVAL_REQUIRED/);
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_delivery_jobs')).rows[0].count, 0);
  for (const change of [{ tenantId: id(99) }, { integrationId: id(99) }, { quoteRevision: 2 }]) {
    await assert.rejects(customer((client) => insert(client, change)), (error) => error.code === '23503');
  }
  await customer(async (client) => {
    await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status='queued',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [tenantId, orderId]);
    await insert(client);
  });
  await assert.rejects(customer((client) => insert(client, { jobId: id(1001) })), (error) => error.code === '23505');
  const row = async (selectedJob = jobId) => (await pool.query(
    'SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2', [tenantId,selectedJob])).rows[0];
  await assert.rejects(customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='dispatching',
    dispatch_attempts=1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId])), (error) => error.code === '23514');
  async function lease(token, seconds = 30, selectedJob = jobId) {
    await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='leased',lease_id=$3,
      lease_expires_at=clock_timestamp()+make_interval(secs=>$4),available_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2`, [tenantId,selectedJob,token,seconds]));
  }
  await lease(id(2000), -1);
  const attempt = (client, token, number = 1, selectedJob = jobId) => client.query(`INSERT INTO catering_delivery_attempts
    (tenant_id,job_id,attempt,lease_id,correlation_id) VALUES ($1,$2,$3,$4,$5)`, [tenantId,selectedJob,number,token,id(90)]);
  await assert.rejects(customer((client) => attempt(client, id(2000))), /LEASE_INVALID/);
  await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='queued',lease_id=NULL,
    lease_expires_at=NULL,available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId]));
  assert.equal((await row()).dispatch_attempts, 0);
  await fixture.setOrderCapability(false);
  await lease(id(2100));
  await assert.rejects(customer((client) => attempt(client, id(2100))), /LEASE_INVALID/);
  await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='deferred',
    lease_id=NULL,lease_expires_at=NULL,available_at=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
  [tenantId,jobId]));
  await fixture.setOrderCapability(true);
  await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='queued',
    available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId]));
  await lease(id(2001), 2);
  await customer(async (client) => {
    await attempt(client, id(2001));
    await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='dispatching',dispatch_attempts=1,
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId]);
  });
  await new Promise((resolve) => setTimeout(resolve, 2100)); // Observe actual DB lease expiry after committed dispatch intent.
  async function observation(client, { token, kind = 'dispatch', outcome = 'unknown', receipt = null,
    status = 'reconciliation_required', selectedJob = jobId, retryable = outcome === 'not_sent' }) {
    const current = (await client.query('SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1 AND id=$2',
      [tenantId,selectedJob])).rows[0];
    const sequence = Number(current.last_observation ?? 0) + 1;
    await client.query(`INSERT INTO catering_delivery_observations
      (tenant_id,job_id,sequence,attempt,lease_id,kind,outcome,failure_code,receipt,correlation_id,retryable)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [tenantId,selectedJob,sequence,current.dispatch_attempts,token,kind,outcome,
      kind === 'recovery' ? 'lease_expired' : outcome === 'transmitted' ? 'none' : 'unknown',
      receipt === null ? null : JSON.stringify(receipt),id(90),retryable]);
    await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status=$3::varchar,last_observation=$4,
      lease_id=NULL,lease_manual=false,lease_expires_at=NULL,
      available_at=CASE WHEN $3::varchar='retry_wait' THEN clock_timestamp() ELSE NULL END,
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
    [tenantId,selectedJob,status,sequence]);
  }
  await assert.rejects(customer((client) => observation(client, { token: id(2001) })), /LEASE_INVALID/);
  await customer((client) => observation(client, { token: id(2001), kind: 'recovery' }));
  assert.equal((await row()).status, 'reconciliation_required');
  await assert.rejects(customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='queued',
    available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId])), /TRANSITION_INVALID/);
  await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='reconciling',
    reconciliation_attempts=reconciliation_attempts+1,lease_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds',
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,jobId,id(2002)]));
  const receipt = { orderId, orderVersion: 1,
    positions: view.order.positions.map((position) => ({ positionId: position.positionId, outcome: 'confirmed' })) };
  await assert.rejects(customer((client) => observation(client, { token: id(2001), kind: 'reconcile',
    outcome: 'transmitted', receipt, status: 'succeeded' })), /LEASE_INVALID/);
  for (const corrupt of [{ ...receipt, orderId: id(99) }, { ...receipt, cost: 1 },
    { ...receipt, positions: [{ positionId: id(99), outcome: 'confirmed' }] },
    { ...receipt, positions: [{ ...receipt.positions[0], outcome: null }] }, { ...receipt, positions: [] }]) {
    await assert.rejects(customer((client) => observation(client, { token: id(2002), kind: 'reconcile',
      outcome: 'transmitted', receipt: corrupt, status: 'succeeded' })), /RECEIPT/);
  }
  await customer((client) => observation(client, { token: id(2002), kind: 'reconcile',
    outcome: 'transmitted', receipt, status: 'succeeded' }));
  assert.equal((await row()).status, 'succeeded'); assert.equal((await row()).dispatch_attempts, 1);
  await assert.rejects(customer((client) => client.query('UPDATE catering_delivery_attempts SET attempt=attempt WHERE tenant_id=$1',
    [tenantId])), (error) => error.code === '42501');
  await assert.rejects(pool.query('DELETE FROM catering_delivery_observations WHERE tenant_id=$1', [tenantId]), /APPEND_ONLY/);
  await assert.rejects(customer((client) => client.query('TRUNCATE catering_delivery_observations')),
    (error) => error.code === '42501');
  const retryOrder = await fixture.createApprovedOrder(2);
  const retryJob = id(1002);
  await customer(async (client) => {
    await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status='queued',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [tenantId,retryOrder.order.orderId]);
    await insert(client, { jobId: retryJob, orderId: retryOrder.order.orderId });
  });
  for (const number of [1,2,3]) {
    const token = id(2200 + number);
    await lease(token, 30, retryJob);
    await customer(async (client) => {
      await attempt(client, token, number, retryJob);
      await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='dispatching',dispatch_attempts=$3,
        updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,retryJob,number]);
    });
    await customer((client) => observation(client, { token, selectedJob: retryJob,
      outcome: number === 3 ? 'unknown' : 'not_sent', status: number === 3 ? 'reconciliation_required' : 'retry_wait' }));
  }
  assert.equal((await row(retryJob)).dispatch_attempts, 3);
  assert.equal((await row(retryJob)).status, 'reconciliation_required');
  for (let number = 1; number <= 10; number++) {
    const token = id(2300 + number);
    await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='reconciling',
      reconciliation_attempts=reconciliation_attempts+1,lease_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds',
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,retryJob,token]));
    await customer((client) => observation(client, { token, kind: 'reconcile', selectedJob: retryJob }));
  }
  await assert.rejects(customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='reconciling',
    reconciliation_attempts=reconciliation_attempts+1,lease_id=$3,lease_expires_at=clock_timestamp()+interval '30 seconds',
    updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,retryJob,id(2400)])), (error) => error.code === '23514');
  assert.equal((await row(retryJob)).status, 'reconciliation_required');
  assert.equal((await row(retryJob)).available_at, null);
  // An explicitly authorized future manual-read command can retain a separate
  // lease without resetting the exhausted automatic budget or replaying writes.
  await customer((client) => client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='reconciling',
    lease_id=$3,lease_manual=true,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND id=$2`, [tenantId,retryJob,id(2401)]));
  const manualReceipt = { orderId: retryOrder.order.orderId, orderVersion: 1,
    positions: retryOrder.order.positions.map((position) => ({ positionId: position.positionId, outcome: 'confirmed' })) };
  await customer((client) => observation(client, { token: id(2401), kind: 'manual_reconcile', selectedJob: retryJob,
    outcome: 'transmitted', receipt: manualReceipt, status: 'succeeded' }));
  assert.equal((await row(retryJob)).reconciliation_attempts, 10);
  assert.equal((await row(retryJob)).dispatch_attempts, 3);
  assert.equal((await row(retryJob)).status, 'succeeded');

  const permanentOrder = await fixture.createApprovedOrder(3);
  const permanentJob = id(1003);
  await customer(async (client) => {
    await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status='queued',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [tenantId,permanentOrder.order.orderId]);
    await insert(client, { jobId: permanentJob, orderId: permanentOrder.order.orderId });
  });
  await lease(id(2500), 30, permanentJob);
  await customer(async (client) => {
    await attempt(client, id(2500), 1, permanentJob);
    await client.query(`UPDATE catering_delivery_jobs SET revision=revision+1,status='dispatching',dispatch_attempts=1,
      updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [tenantId,permanentJob]);
  });
  await customer((client) => observation(client, { token: id(2500), selectedJob: permanentJob,
    outcome: 'not_sent', retryable: false, status: 'failed' }));
  assert.equal((await row(permanentJob)).status, 'failed');
  assert.equal((await row(permanentJob)).dispatch_attempts, 1);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty032 before retained031/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty031 before unchanged030/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty030 before unchanged029/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty029 before unchanged028/older guards.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty028 before unchanged027.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Version grants overlay017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Revoke overlay016 before recreating its tables.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual facts schema050.
  await assert.rejects(rollbackLatest(pool), /CATERING_DELIVERY_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  assert.equal(await isPostgresSchemaReady(pool), true);
  await customer(async (client) => {
    assert.deepEqual((await client.query('SELECT * FROM catering_delivery_jobs WHERE tenant_id=$1', [id(99)])).rows, []);
  });
  const event = fixture.auditService.createEvent({ ...fixture.context(), action: 'catering.delivery.queued',
    targetType: 'catering_order', targetId: orderId, previousState: { status: 'released' }, newState: { status: 'queued' },
    outcome: 'success', retentionClass: 'business', metadata: { operation: 'catering_delivery_enqueue' } });
  await customer((client) => fixture.auditRepository.appendWithClient(client, event));
  await pool.query(`TRUNCATE catering_unsent_replacements,catering_order_withdrawals,
    catering_delivery_observations,catering_delivery_attempts,catering_delivery_jobs`);
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty032 before retained031/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty031 before unchanged030/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty030 before unchanged029/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty029 before unchanged028/older guards.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty028 before unchanged027.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Version grants overlay017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Revoke overlay016 before recreating its tables.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual facts schema050.
  await assert.rejects(rollbackLatest(pool), /CATERING_DELIVERY_ROLLBACK_REQUIRES_REVIEW/);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  assert.equal(await fixture.auditRepository.verifyTenantChain(tenantId), true);
  const resetOrder = await fixture.createApprovedOrder(1);
  await customer(async (client) => {
    await client.query(`UPDATE catering_order_version_states SET revision=revision+1,status='queued',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND order_id=$2 AND version=1`, [tenantId,resetOrder.order.orderId]);
    await insert(client, { jobId: id(1001), orderId: resetOrder.order.orderId });
  });
  assert.equal((await pool.query('SELECT count(*)::integer AS count FROM catering_delivery_jobs')).rows[0].count, 1);
  const resetClient = await pool.connect();
  try {
    await resetClient.query(`SET ROLE "${roles.reset}"`);
    const scoped = { query: (query, values) => resetClient.query(query, values), release() {} };
    const reset = createPostgresDemoResetRepository({ pool: { query: scoped.query, async connect() { return scoped; } },
      expectedDatabaseName: name, expectedResetRole: roles.reset });
    assert.equal((await reset.reset({ fixture: DEMO_FIXTURE, checksum: DEMO_FIXTURE_CHECKSUM })).checksum, DEMO_FIXTURE_CHECKSUM);
  } finally { await resetClient.query('RESET ROLE'); resetClient.release(); }
  for (const table of ['catering_delivery_jobs','catering_delivery_attempts','catering_delivery_observations']) {
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Empty033 before unchanged032/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty032 before retained031/older reset grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty031 before unchanged030/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty030 before unchanged029/older grants.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty029 before unchanged028/older guards.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty028 before unchanged027.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty027 before unchanged026.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Empty overlay026 before025.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Protected runtime025 before retained Microsoft024.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Microsoft flow024 before retained Customer023.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Customer023 before retained enrollment022.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Enrollment grants022 before retained publication021.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Publication grants021 before source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Catalogue source grants020.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Platform passkey reset grants019 before schema053.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Unsent grants018 before schema052.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles: roles }), true); // Version grants overlay017.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Manual grants overlay016.
  assert.equal(await rollbackLatestDemoMigration(pool, { roles }), true); // Delivery grants overlay015.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before unchanged070/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft operation proofs070 before069.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft group authority069 before068.
  assert.equal(await rollbackLatest(pool),true); // Empty role provenance068 before067.
  assert.equal(await rollbackLatest(pool),true); // Empty owner roles067 before unchanged066/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty segment066 before unchanged065/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty owner audit065 before unchanged064/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty onboarding064 before unchanged063/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty private calendar063 before unchanged062/older guards.
  assert.equal(await rollbackLatest(pool),true); // Empty source-lock062 before unchanged061/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty handoff061 before unchanged060/older guard.
  assert.equal(await rollbackLatest(pool),true); // Empty060 before059.
  assert.equal(await rollbackLatest(pool),true); // Empty protected runtime059 before retained Microsoft058.
  assert.equal(await rollbackLatest(pool),true); // Empty Microsoft flow058 before retained Customer057.
  assert.equal(await rollbackLatest(pool),true); // Empty Customer057 before retained enrollment056.
  assert.equal(await rollbackLatest(pool),true); // Empty enrollment056 before retained publication055.
  assert.equal(await rollbackLatest(pool), true); // Empty publication schema055 before original054/older guard.
  assert.equal(await rollbackLatest(pool), true); // Empty provider catalogue source schema054.
  assert.equal(await rollbackLatest(pool), true); // Empty Platform passkey storage schema053.
  assert.equal(await rollbackLatest(pool), true); // Empty unsent schema052.
  assert.equal(await rollbackLatest(pool), true); // Empty version proposal schema051.
  assert.equal(await rollbackLatest(pool), true); // Empty manual facts schema050.
  assert.equal(await rollbackLatest(pool), true);
  assert.equal(await isPostgresSchemaReady(pool), false);
  await migrateUp(pool); await migrateDemoUp(pool, { roles });
  assert.equal(await isPostgresSchemaReady(pool), true);
});
