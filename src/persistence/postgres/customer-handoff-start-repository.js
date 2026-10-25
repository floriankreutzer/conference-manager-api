import { randomUUID,createHash } from 'node:crypto';
import { normalizeSyntheticHandoffScope,SYNTHETIC_HANDOFF_START_SECONDS,SYNTHETIC_HANDOFF_RETAINED_GLOBAL_LIMIT }
  from '../../domain/synthetic-handoff.js';
import { normalizeOwnerCustomerAccessScope,OWNER_CUSTOMER_ACCESS_START_SECONDS,OWNER_CUSTOMER_ACCESS_RETAINED_GLOBAL_LIMIT }
  from '../../domain/owner-customer-handoff.js';
import { withPostgresTransaction } from './transaction.js';
import { requireProtectedRuntimeSharedExecutionScope } from './protected-runtime-execution-scopes.js';

const HASH=/^[a-f0-9]{64}$/;

// Anonymous custody cannot approve a handoff and has no Platform audit key,
// Platform principal or privileged proof authority. Start and budget work stay
// under the fixed current Customer deployment lease and one business transaction.
export function createPostgresCustomerHandoffStartRepository(pool,{ scope,browserBinding,kind }={}) {
  if (!['synthetic','owner_real'].includes(kind)) throw new TypeError('CUSTOMER_HANDOFF_START_KIND_INVALID');
  const legacy=kind==='synthetic',prefix=legacy ? 'synthetic' : 'owner';
  const errorPrefix=legacy ? 'SYNTHETIC_HANDOFF' : 'OWNER_HANDOFF';
  function denied(code=`${errorPrefix}_DENIED`) { throw new Error(code); }
  function instant(value) { if (!(value instanceof Date) || !Number.isFinite(value.getTime())) denied();return value; }
  scope=legacy ? normalizeSyntheticHandoffScope(scope) : normalizeOwnerCustomerAccessScope(scope);
  if (typeof pool?.query!=='function' || typeof pool?.connect!=='function' || typeof browserBinding?.issueStart!=='function') {
    throw new TypeError(`${errorPrefix}_START_CONFIGURATION_INVALID`);
  }
  // These identifiers are a closed infrastructure vocabulary, never input.
  const handoffs=legacy ? 'synthetic_customer_handoffs' : 'owner_customer_handoffs';
  const budgets=legacy ? 'synthetic_handoff_start_budgets' : 'owner_handoff_start_budgets';
  const startSeconds=legacy ? SYNTHETIC_HANDOFF_START_SECONDS : OWNER_CUSTOMER_ACCESS_START_SECONDS;
  const globalLimit=legacy ? SYNTHETIC_HANDOFF_RETAINED_GLOBAL_LIMIT : OWNER_CUSTOMER_ACCESS_RETAINED_GLOBAL_LIMIT;
  const protection={ environment: scope.environment,securityEpoch: scope.securityEpoch };
  const fixed=[scope.environment,scope.securityEpoch,scope.platformSecurityEpoch,scope.customerOrigin,scope.platformOrigin];
  const globalKey=createHash('sha256').update(`${prefix}-handoff-global-start:v1:${scope.environment}`,'ascii').digest('hex');
  async function now(client) { return instant((await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now); }
  async function prune(client) {
    await client.query({ name: `${prefix}-handoff-expired-cleanup`,text: `WITH expired AS (
      SELECT custody.environment,custody.id FROM ${handoffs} custody WHERE custody.environment=$1
        AND ((custody.status<>'consumed' AND custody.expires_at<clock_timestamp()-interval '1 hour')
          OR (custody.status='consumed' AND custody.consumed_at<clock_timestamp()-interval '24 hours'
            AND NOT EXISTS(SELECT 1 FROM sessions session WHERE session.id=custody.customer_session_id
              AND session.revoked_at IS NULL AND session.expires_at>clock_timestamp())))
      ORDER BY custody.created_at,custody.id LIMIT 20 FOR UPDATE OF custody SKIP LOCKED)
      DELETE FROM ${handoffs} custody USING expired
      WHERE custody.environment=expired.environment AND custody.id=expired.id`,values: [scope.environment] });
    await client.query({ name: `${prefix}-handoff-budget-cleanup`,text: `WITH stale AS (
      SELECT environment,kind,key_hash FROM ${budgets} WHERE environment=$1
        AND last_issued_at<clock_timestamp()-interval '24 hours' ORDER BY last_issued_at,kind,key_hash LIMIT 20 FOR UPDATE SKIP LOCKED)
      DELETE FROM ${budgets} budget USING stale
      WHERE budget.environment=stale.environment AND budget.kind=stale.kind AND budget.key_hash=stale.key_hash`,
    values: [scope.environment] });
  }
  async function allocate(client,sourceKey,time) {
    const result=await client.query({ name: `${prefix}-handoff-budget-current`,text: `SELECT kind,window_started_at,issue_count
      FROM ${budgets} WHERE environment=$1
        AND ((kind='global' AND key_hash=$2) OR (kind='source' AND key_hash=$3)) FOR UPDATE`,
    values: [scope.environment,globalKey,sourceKey] });
    for (const row of result.rows) {
      instant(row.window_started_at);
      if (!['global','source'].includes(row.kind) || !Number.isSafeInteger(row.issue_count) || row.issue_count<0
        || row.issue_count>30 || row.window_started_at>time) denied(`${errorPrefix}_BUDGET_INVALID`);
      if (time.getTime()-row.window_started_at.getTime()<60_000 && row.issue_count>=(row.kind==='global' ? 30 : 5)) return false;
    }
    for (const [kind,key] of [['global',globalKey],['source',sourceKey]]) await client.query({ name: `${prefix}-handoff-budget-spend`,text:
      `INSERT INTO ${budgets}(environment,kind,key_hash,window_started_at,issue_count,last_issued_at)
       VALUES($1,$2,$3,$4,1,$4) ON CONFLICT(environment,kind,key_hash) DO UPDATE SET
         issue_count=CASE WHEN ${budgets}.window_started_at<=$4::timestamptz-interval '1 minute'
           THEN 1 ELSE ${budgets}.issue_count+1 END,
         window_started_at=CASE WHEN ${budgets}.window_started_at<=$4::timestamptz-interval '1 minute'
           THEN $4 ELSE ${budgets}.window_started_at END,last_issued_at=$4`,
      values: [scope.environment,kind,key,time] });
    return true;
  }
  return Object.freeze({
    async start({ sourceKey }={}) {
      requireProtectedRuntimeSharedExecutionScope(pool,protection);
      if (typeof sourceKey!=='string' || !HASH.test(sourceKey)) denied();
      return withPostgresTransaction(pool,async client=>{
        const lock=await client.query({ name: `${prefix}-handoff-start-lock`,text:
          `SELECT pg_try_advisory_xact_lock(hashtext('${prefix}-handoff-start-v1'),hashtext($1)) AS acquired`,
        values: [scope.environment] });
        if (lock.rows[0]?.acquired!==true) return Object.freeze({ status: 'busy' });
        await prune(client);
        const free=await client.query({ name: `${prefix}-handoff-global-free-slot`,text: `SELECT candidate.slot
          FROM generate_series(1,$2::integer) AS candidate(slot) WHERE NOT EXISTS(
            SELECT 1 FROM ${handoffs} custody WHERE custody.environment=$1 AND custody.global_slot=candidate.slot)
          ORDER BY candidate.slot LIMIT 1`,values: [scope.environment,globalLimit] });
        if (free.rowCount!==1) return Object.freeze({ status: 'capacity' });
        const time=await now(client);
        if (!await allocate(client,sourceKey,time)) return Object.freeze({ status: 'limited' });
        const flowId=randomUUID(),start=browserBinding.issueStart(flowId);
        const expiresAt=new Date(time.getTime()+startSeconds*1000);
        const stored=await client.query({ name: `${prefix}-handoff-start-insert`,text: `INSERT INTO ${handoffs}
          (environment,security_epoch,platform_security_epoch,customer_origin,platform_origin,id,global_slot,
            state_hash,browser_verifier,source_key_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        values: [...fixed,flowId,free.rows[0].slot,start.stateHash,start.browserVerifier,sourceKey,time,expiresAt] });
        if (stored.rowCount!==1 || stored.rows[0]?.id!==flowId) denied(`${errorPrefix}_START_FAILED`);
        return Object.freeze({ status: 'started',flowId,state: start.state,browserToken: start.browserToken,
          expiresAt: expiresAt.toISOString() });
      });
    },
  });
}
