import { withPostgresTransaction } from './transaction.js';

// Fixed, indexed twenty-row sweeps. No browser clock, arbitrary retention age,
// table/column selector, trigger bypass or real identity/history deletion port.
export async function pruneCustomerAnonymousEmailState(pool,{ environment } = {}) {
  if (!['dev','int','prod'].includes(environment) || typeof pool?.connect!=='function') {
    throw new TypeError('CUSTOMER_EMAIL_RETENTION_CONFIGURATION_INVALID');
  }
  return withPostgresTransaction(pool,async client => {
    const lock=await client.query({ name: 'customer-email-retention-try-lock',
      text: 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 714537)) AS acquired',values: [environment] });
    if (lock.rows[0]?.acquired!==true) return Object.freeze({ anonymousChallenges: 0,staleBudgets: 0 });
    const challenges=await client.query({ name: 'customer-email-retention-anonymous',text: `WITH expired AS (
      SELECT environment,id FROM customer_email_challenges WHERE environment=$1 AND mailbox_id IS NULL
        AND admission_snapshot='[]'::jsonb AND verified_at IS NULL AND expires_at<clock_timestamp()-interval '1 hour'
      ORDER BY expires_at,id LIMIT 20 FOR UPDATE SKIP LOCKED)
      DELETE FROM customer_email_challenges challenge USING expired
      WHERE challenge.environment=expired.environment AND challenge.id=expired.id RETURNING challenge.id`,values: [environment] });
    const budgets=await client.query({ name: 'customer-email-retention-budgets',text: `WITH stale AS (
      SELECT environment,kind,key_hash FROM customer_access_abuse_budgets WHERE environment=$1
        AND window_started_at<clock_timestamp()-interval '24 hours'
        AND (last_issued_at IS NULL OR last_issued_at<clock_timestamp()-interval '24 hours')
      ORDER BY window_started_at,kind,key_hash LIMIT 20 FOR UPDATE SKIP LOCKED)
      DELETE FROM customer_access_abuse_budgets budget USING stale
      WHERE budget.environment=stale.environment AND budget.kind=stale.kind AND budget.key_hash=stale.key_hash
      RETURNING budget.kind`,values: [environment] });
    if (![challenges.rowCount,budgets.rowCount].every(value => Number.isSafeInteger(value) && value>=0 && value<=20)) {
      throw new Error('CUSTOMER_EMAIL_RETENTION_RESULT_INVALID');
    }
    return Object.freeze({ anonymousChallenges: challenges.rowCount,staleBudgets: budgets.rowCount });
  });
}
