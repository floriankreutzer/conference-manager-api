import { withPostgresTransaction } from './transaction.js';

const HASH = /^[a-f0-9]{64}$/;
const HOUR = 3_600_000;
const LIMITS = Object.freeze({ source: { issue: 30,failure: 50 },recipient: { issue: 3,failure: 10 } });

// Locks source then recipient before any challenge lock. Unknown recipients use
// the same keyed counters. A denied proof must return normally after recording
// failure so the surrounding transaction commits the attempt and abuse evidence.
export async function withCustomerEmailBudget(pool, { environment, sourceKey, recipientKey, operation } = {}, work) {
  if (!['dev','int','prod'].includes(environment) || typeof sourceKey !== 'string' || !HASH.test(sourceKey)
    || typeof recipientKey !== 'string' || !HASH.test(recipientKey)
    || !['issue','verify'].includes(operation) || typeof work !== 'function') throw new TypeError('CUSTOMER_EMAIL_BUDGET_INVALID');
  return withPostgresTransaction(pool,async client => {
    const time = await client.query('SELECT clock_timestamp() AS now'); let now = time.rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('CUSTOMER_EMAIL_BUDGET_CLOCK_INVALID');
    const counters = [];
    for (const [kind,key] of [['source',sourceKey],['recipient',recipientKey]]) {
      await client.query({ name: 'customer-email-budget-insert',text: `INSERT INTO customer_access_abuse_budgets
        (environment,kind,key_hash,window_started_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(environment,kind,key_hash) DO NOTHING`,values: [environment,kind,key,now] });
      const result = await client.query({ name: 'customer-email-budget-lock',text: `SELECT window_started_at,
        issue_count,failure_count,last_issued_at FROM customer_access_abuse_budgets
        WHERE environment=$1 AND kind=$2 AND key_hash=$3 FOR UPDATE`,values: [environment,kind,key] });
      if (result.rowCount !== 1) throw new Error('CUSTOMER_EMAIL_BUDGET_UNAVAILABLE');
      const row = result.rows[0];
      if (!(row.window_started_at instanceof Date) || !Number.isFinite(row.window_started_at.getTime())
        || !Number.isSafeInteger(row.issue_count) || row.issue_count < 0 || row.issue_count > 100
        || !Number.isSafeInteger(row.failure_count) || row.failure_count < 0 || row.failure_count > 100) {
        throw new Error('CUSTOMER_EMAIL_BUDGET_UNAVAILABLE');
      }
      counters.push({ kind,key,row });
    }
    // Sample again after acquiring both locks; a concurrent transaction may have
    // started this window while this request was waiting for a lock.
    now = (await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('CUSTOMER_EMAIL_BUDGET_CLOCK_INVALID');
    for (const { kind,key,row } of counters) {
      if (row.window_started_at.getTime() > now.getTime()) throw new Error('CUSTOMER_EMAIL_BUDGET_UNAVAILABLE');
      // Keep the old window until its most recent send has cleared cooldown.
      // Resetting last_issued_at early would permit a boundary resend burst.
      if (now.getTime()-row.window_started_at.getTime() >= HOUR
        && (row.last_issued_at === null || (row.last_issued_at instanceof Date
          && now.getTime()-row.last_issued_at.getTime() >= 60_000))) {
        row.window_started_at = now; row.issue_count = 0; row.failure_count = 0; row.last_issued_at = null;
        await client.query({ name: 'customer-email-budget-reset',text: `UPDATE customer_access_abuse_budgets
          SET window_started_at=$4,issue_count=0,failure_count=0,last_issued_at=NULL
          WHERE environment=$1 AND kind=$2 AND key_hash=$3`,values: [environment,kind,key,now] });
      }
    }
    if (counters.some(({ kind,row }) => row.failure_count >= LIMITS[kind].failure
      || (operation === 'issue' && (row.issue_count >= LIMITS[kind].issue
        || (kind === 'recipient' && row.last_issued_at !== null
          && (!(row.last_issued_at instanceof Date) || now.getTime()-row.last_issued_at.getTime()<60_000)))))) {
      return Object.freeze({ status: 'limited' });
    }
    async function increment(column) {
      // These two complete SQL statements are server-selected, never interpolated.
      const issue = column === 'issue';
      for (const { kind,key } of counters) await client.query({
        name: issue ? 'customer-email-budget-charge-issue' : 'customer-email-budget-charge-failure',
        text: issue ? `UPDATE customer_access_abuse_budgets SET issue_count=issue_count+1,last_issued_at=$4
          WHERE environment=$1 AND kind=$2 AND key_hash=$3`
          : `UPDATE customer_access_abuse_budgets SET failure_count=failure_count+1
          WHERE environment=$1 AND kind=$2 AND key_hash=$3`,
        values: issue ? [environment,kind,key,now] : [environment,kind,key],
      });
    }
    if (operation === 'issue') await increment('issue');
    let failureRecorded = false, active = true;
    try {
      return await work({ client,now,async recordFailure() {
        if (!active || operation !== 'verify' || failureRecorded) throw new Error('CUSTOMER_EMAIL_FAILURE_RECORD_INVALID');
        failureRecorded = true; await increment('failure');
      } });
    } finally { active = false; }
  });
}
