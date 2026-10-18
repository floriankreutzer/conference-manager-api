import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../src/audit/event.js';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresAuditRepository } from '../src/persistence/postgres/audit-repository.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

test('standalone audit append cannot deadlock a Tenant-locked business transaction', async (t) => {
  const database = loadDatabaseConfig(process.env, 'test');
  assert.ok(database.databaseUrl);
  const pool = createPostgresPool({ mode: 'test', ...database });
  t.after(() => pool.end());
  await migrateUp(pool);
  const tenantId = randomUUID();
  await pool.query("INSERT INTO tenants (id,display_name,status) VALUES ($1,'Audit lock regression','active')", [tenantId]);
  const repository = createPostgresAuditRepository(pool, { hmacSecret: 'audit-lock-order-regression-secret-32-bytes' });
  const event = targetId => ({ tenantId, actorUserId: null, action: AUDIT_ACTION.REQUEST_TRANSITION,
    targetType: 'request', targetId, previousState: { status: 'Submitted' }, newState: { status: 'InReview' },
    occurredAt: new Date().toISOString(), correlationId: randomUUID(), outcome: AUDIT_OUTCOME.SUCCESS,
    metadata: { transition: 'start_review' }, retentionClass: AUDIT_RETENTION_CLASS.BUSINESS });
  const business = await pool.connect(); const standalone = await pool.connect();
  let pending;
  try {
    await business.query('BEGIN'); await standalone.query('BEGIN');
    await business.query("SET LOCAL statement_timeout = '5s'");
    await standalone.query("SET LOCAL statement_timeout = '5s'");
    await business.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    const { rows: [{ pid }] } = await standalone.query('SELECT pg_backend_pid() AS pid');
    // Start the actual append while the business transaction owns the Tenant.
    // Observe a real lock wait before asking that owner to append its own event.
    pending = repository.appendWithClient(standalone, event('standalone'))
      .then(value => ({ value }), error => ({ error }));
    let waiting = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
      if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
      await delay(10);
    }
    assert.equal(waiting, true, 'standalone append must encounter the held Tenant lock');
    const first = await repository.appendWithClient(business, event('business'));
    assert.ok(first); await business.query('COMMIT');
    const result = await pending;
    assert.ifError(result.error); assert.ok(result.value);
    await standalone.query('COMMIT');
    assert.equal(result.value.previousHash, first.eventHash);
    assert.equal(await repository.verifyTenantChain(tenantId), true);
    assert.deepEqual((await repository.listByTenantId(tenantId)).map(row => row.targetId), ['standalone', 'business']);
  } finally {
    await business.query('ROLLBACK');
    await standalone.query('ROLLBACK');
    if (pending) await pending;
    business.release(); standalone.release();
  }
});
