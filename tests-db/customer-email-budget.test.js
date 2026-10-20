import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { withCustomerEmailBudget } from '../src/persistence/postgres/customer-email-budget.js';
import { migrateUp } from '../scripts/db-migrations.mjs';

const config = { environment: 'int',sourceKey: 'a'.repeat(64),recipientKey: 'b'.repeat(64),operation: 'issue' };
test('email budgets survive concurrent requests, failed proofs, new sources and rollback', async t => {
  const database = loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool = createPostgresPool({ mode: 'test',...database }); t.after(() => pool.end()); await migrateUp(pool);
  const expired='d5000000-0000-4000-8000-000000000001';
  await pool.query(`INSERT INTO customer_email_challenges(environment,id,recipient_lookup_hash,flow_browser_verifier,
    code_verifier,browser_verifier,admission_snapshot,created_at,expires_at)
    VALUES('int',$1,$2,$2,$2,$2,'[]'::jsonb,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '110 minutes')`,
  [expired,'0'.repeat(64)]);
  await pool.query(`INSERT INTO customer_access_abuse_budgets(environment,kind,key_hash,window_started_at)
    VALUES('int','recipient',$1,clock_timestamp()-interval '25 hours')`,['0'.repeat(64)]);
  let calls = 0; const issue = () => withCustomerEmailBudget(pool,config,async () => { calls++; return { status: 'queued' }; });
  const simultaneous = await Promise.all([issue(),issue()]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_email_challenges WHERE id=$1',[expired])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_access_abuse_budgets WHERE key_hash=$1',
    ['0'.repeat(64)])).rows[0].n,0);
  assert.deepEqual(simultaneous.map(item => item.status).sort(),['limited','queued']); assert.equal(calls,1);
  assert.equal((await withCustomerEmailBudget(pool,{ ...config,sourceKey: 'c'.repeat(64) },
    async () => { throw new Error('RECIPIENT_COOLDOWN_BYPASS'); })).status,'limited');
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await withCustomerEmailBudget(pool,{ ...config,operation: 'verify' },async ({ recordFailure }) => {
      await recordFailure(); return { status: 'rejected' };
    });
    assert.equal(result.status,'rejected');
  }
  const blocked = await withCustomerEmailBudget(pool,{ ...config,operation: 'verify',sourceKey: 'd'.repeat(64) },
    async () => { throw new Error('RECIPIENT_ATTEMPT_BYPASS'); });
  assert.equal(blocked.status,'limited');
  const stored = await pool.query(`SELECT failure_count FROM customer_access_abuse_budgets
    WHERE environment='int' AND kind='recipient' AND key_hash=$1`,[config.recipientKey]);
  assert.equal(stored.rows[0].failure_count,10);
  const fresh = { ...config,sourceKey: 'e'.repeat(64),recipientKey: 'f'.repeat(64) };
  await assert.rejects(withCustomerEmailBudget(pool,fresh,async () => { throw new Error('ROLLBACK_REQUIRED'); }),/ROLLBACK_REQUIRED/);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM customer_access_abuse_budgets
    WHERE key_hash IN ($1,$2)`,[fresh.sourceKey,fresh.recipientKey])).rows[0].n,0);
  await pool.query(`UPDATE customer_access_abuse_budgets SET window_started_at=clock_timestamp()-interval '61 minutes',
    last_issued_at=clock_timestamp()-interval '30 seconds',issue_count=3,failure_count=0 WHERE environment='int'`);
  assert.equal((await issue()).status,'limited'); assert.equal((await issue()).status,'limited');
  await pool.query(`UPDATE customer_access_abuse_budgets SET window_started_at=clock_timestamp()-interval '61 minutes',
    last_issued_at=clock_timestamp()-interval '61 minutes' WHERE environment='int'`);
  assert.equal((await issue()).status,'queued'); assert.equal(calls,2);
  assert.equal((await pool.query(`SELECT failure_count FROM customer_access_abuse_budgets
    WHERE environment='int' AND kind='recipient' AND key_hash=$1`,[config.recipientKey])).rows[0].failure_count,0);
});
