import { createHash } from 'node:crypto';
import { reconcileJiraPrScope } from './jira-pr-scope.mjs';
import { deriveJiraScopeRevision, normalizeJiraScopeDecision, normalizeJiraScopeExecution } from './jira-register-scope-revision.mjs';

const failure = () => new Error('JIRA_REGISTER_JOURNAL_UNVERIFIED');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

/** A closed, bounded wire value. A hash authenticates nothing without the trusted journal. */
export function canonicalJiraRegister(scope) {
  if (!keys(scope, ['schemaVersion', 'issueKey', 'version', 'closed', 'entries'])
    || typeof scope.issueKey !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(scope.issueKey)
    || !reconcileJiraPrScope(scope, { issueKey: scope.issueKey, complete: true, stale: false,
      pullRequests: scope.entries }).complete) throw failure();
  const entries = scope.entries.map(entry => {
    const fields = ['repository', 'number', 'kind'];
    if (entry.kind !== 'delivery') fields.push('reason');
    if (entry.kind === 'superseded') fields.push('replacedBy');
    if (!keys(entry, fields) || (entry.kind === 'superseded'
      && !keys(entry.replacedBy, ['repository', 'number']))) throw failure();
    return { repository: entry.repository, number: entry.number, kind: entry.kind,
      ...(entry.kind !== 'delivery' ? { reason: entry.reason } : {}),
      ...(entry.kind === 'superseded' ? { replacedBy: {
        repository: entry.replacedBy.repository, number: entry.replacedBy.number } } : {}) };
  }).sort((a, b) => `${a.repository}#${a.number}`.localeCompare(`${b.repository}#${b.number}`));
  const value = { schemaVersion: 1, issueKey: scope.issueKey, version: scope.version, closed: true, entries };
  const serialized = JSON.stringify(value);
  // Jira entity properties have a smaller limit than the existing read transport.
  if (Buffer.byteLength(serialized, 'utf8') > 32768) throw failure();
  return { scope: value, digest: createHash('sha256').update(serialized).digest('hex') };
}

function target({ cloudId, issueKey, issueId } = {}) {
  if (typeof cloudId !== 'string' || !UUID.test(cloudId)
    || typeof issueKey !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(issueKey)
    || typeof issueId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(issueId)) throw failure();
  return [cloudId, issueKey, issueId];
}

function decode(row, issueKey, issueId) {
  if (!row) return null;
  const normalized = canonicalJiraRegister(row.scope);
  if (row.issue_id !== issueId || normalized.scope.issueKey !== issueKey
    || row.version !== normalized.scope.version || normalized.digest !== row.digest
    || !['pending', 'confirmed'].includes(row.state)) throw failure();
  return { scope: normalized.scope, digest: normalized.digest, state: row.state };
}

async function readScopeRevision(client, values, binding, { commentId, expectedDecisionDigest, actorId }) {
  if (typeof commentId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(commentId)
    || typeof expectedDecisionDigest !== 'string' || !HASH.test(expectedDecisionDigest)
    || typeof actorId !== 'string' || !/^[a-zA-Z0-9:-]{1,128}$/.test(actorId)) throw failure();
  const { rows } = await client.query(`SELECT revision.*, next.issue_id, next.scope, next.digest, next.state,
    prior.issue_id AS prior_issue_id, prior.scope AS prior_scope, prior.digest AS prior_digest, prior.state AS prior_state
    FROM cm_delivery.register_scope_revisions revision
    JOIN cm_delivery.register_journal next USING (cloud_id, issue_key, version)
    JOIN cm_delivery.register_journal prior ON prior.cloud_id=revision.cloud_id
      AND prior.issue_key=revision.issue_key AND prior.version=revision.previous_version
    WHERE revision.cloud_id=$1 AND revision.issue_key=$2 AND revision.comment_id=$3`,
  [...values.slice(0, 2), commentId]);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw failure();
  const row = rows[0];
  const decision = normalizeJiraScopeDecision({ commentId: row.comment_id, actorId: row.actor_id,
    createdAt: row.comment_created_at?.toISOString(), decisionText: row.decision_text, decisionDigest: row.decision_digest });
  const execution = normalizeJiraScopeExecution({ sourceSha: row.source_sha, runId: row.workflow_run_id,
    runAttempt: row.workflow_run_attempt, githubActorId: row.github_actor_id });
  const next = decode(row, binding.issueKey, binding.issueId);
  const prior = decode({ issue_id: row.prior_issue_id, scope: row.prior_scope, digest: row.prior_digest,
    state: row.prior_state, version: row.previous_version }, binding.issueKey, binding.issueId);
  if (decision.decisionDigest !== expectedDecisionDigest || decision.actorId !== actorId
    || row.previous_digest !== prior.digest
    || canonicalJiraRegister(deriveJiraScopeRevision(prior, decision)).digest !== next.digest) throw failure();
  return { ...next, decision, execution };
}

/**
 * Trusted database adapter, not a Jira writer or readiness authority. The dedicated
 * integration role must be isolated from Jira editors and all application roles.
 * Transactions serialize journal changes only; they do not lock an external API.
 */
export function createPostgresJiraRegisterJournal(pool) {
  async function transaction(binding, operation) {
    const values = target(binding);
    let client;
    let discard = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      // A transaction lock also serializes the first enrollment, before a row exists.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`cm-jira-register:${values[0]}:${values[1]}`]);
      const { rows } = await client.query(`SELECT issue_id, version, scope, digest, state
        FROM cm_delivery.register_journal WHERE cloud_id=$1 AND issue_key=$2 ORDER BY version DESC LIMIT 1`,
      values.slice(0, 2));
      const current = decode(rows[0], binding.issueKey, binding.issueId);
      const result = await operation(client, values, current);
      await client.query('COMMIT');
      return result;
    } catch {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
      }
      // Includes an unknown COMMIT outcome: caller must re-read, never assume failure means absence.
      throw failure();
    } finally {
      client?.release(discard);
    }
  }

  return Object.freeze({
    read(binding) {
      return transaction(binding, async (_client, _values, current) => current);
    },
    prepare({ scope, expectedDigest = null, claimWrite = false, ...binding } = {}) {
      return transaction(binding, async (client, values, current) => {
        const next = canonicalJiraRegister(scope);
        if (typeof claimWrite !== 'boolean' || next.scope.issueKey !== binding.issueKey
          || (expectedDigest !== null && (typeof expectedDigest !== 'string' || !HASH.test(expectedDigest)))) throw failure();
        // An exact duplicate is recoverable, but never grants permission to repeat a Jira PUT.
        if (current?.digest === next.digest) return current;
        if (current === null) {
          // Unanchored Jira exceptions must not acquire integration provenance by enrollment.
          if (expectedDigest !== null || next.scope.version !== 1
            || next.scope.entries.some(entry => entry.kind !== 'delivery')) throw failure();
        } else if (current.state !== 'confirmed' || current.digest !== expectedDigest
          || next.scope.version !== current.scope.version + 1) throw failure();
        if (current) {
          // This automatic path only adds obligations. Explicit exception/reclassification
          // decisions require a separately authorized path; they cannot be smuggled in here.
          const entries = new Map(next.scope.entries.map(entry => [`${entry.repository}#${entry.number}`, entry]));
          for (const old of current.scope.entries) {
            if (JSON.stringify(entries.get(`${old.repository}#${old.number}`)) !== JSON.stringify(old)) throw failure();
          }
          const prior = new Set(current.scope.entries.map(entry => `${entry.repository}#${entry.number}`));
          if (next.scope.entries.length <= current.scope.entries.length
            || next.scope.entries.some(entry => !prior.has(`${entry.repository}#${entry.number}`)
              && entry.kind !== 'delivery')) throw failure();
        }
        await client.query(`INSERT INTO cm_delivery.register_journal
          (cloud_id, issue_key, issue_id, version, scope, digest, state)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,'pending')`,
        [...values, next.scope.version, JSON.stringify(next.scope), next.digest]);
        if (claimWrite) {
          await client.query(`INSERT INTO cm_delivery.register_write_receipts (cloud_id, issue_key, version)
            VALUES ($1,$2,$3)`, [...values.slice(0, 2), next.scope.version]);
        }
        // Only the creator of a new atomically claimed intent may submit its HTTP write.
        // Replays and unknown COMMIT outcomes never return a fresh dispatch claim.
        return { ...next, state: 'pending', ...(claimWrite ? { writeClaimed: true } : {}) };
      });
    },
    readScopeRevision({ commentId, expectedDecisionDigest, actorId, ...binding } = {}) {
      return transaction(binding, (client, values) => readScopeRevision(client, values, binding,
        { commentId, expectedDecisionDigest, actorId }));
    },
    prepareScopeRevision({ decision: suppliedDecision, execution: suppliedExecution, ...binding } = {}) {
      return transaction(binding, async (client, values, current) => {
        const decision = normalizeJiraScopeDecision(suppliedDecision);
        const execution = normalizeJiraScopeExecution(suppliedExecution);
        const existing = await readScopeRevision(client, values, binding, { commentId: decision.commentId,
          expectedDecisionDigest: decision.decisionDigest, actorId: decision.actorId });
        if (existing) {
          if (JSON.stringify(existing.decision) !== JSON.stringify(decision)) throw failure();
          // Historical confirmation or recovery retains the original execution and dispatch claim.
          return existing;
        }
        // An original transition may still be unconfirmed even while its register
        // is confirmed. Its evidence binding cannot be revised underneath it.
        const pending = await client.query(`SELECT 1 FROM cm_delivery.transition_journal
          WHERE cloud_id=$1 AND issue_key=$2 AND state='pending' LIMIT 1`, values.slice(0, 2));
        if (pending.rows.length !== 0) throw failure();
        const next = canonicalJiraRegister(deriveJiraScopeRevision(current, decision));
        if (next.scope.issueKey !== binding.issueKey) throw failure();
        await client.query(`INSERT INTO cm_delivery.register_journal
          (cloud_id, issue_key, issue_id, version, scope, digest, state)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,'pending')`,
        [...values, next.scope.version, JSON.stringify(next.scope), next.digest]);
        await client.query(`INSERT INTO cm_delivery.register_scope_revisions
          (cloud_id, issue_key, version, previous_version, previous_digest, comment_id, actor_id,
            comment_created_at, decision_text, decision_digest, source_sha, workflow_run_id, workflow_run_attempt, github_actor_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [...values.slice(0, 2), next.scope.version, current.scope.version, current.digest, decision.commentId,
          decision.actorId, decision.createdAt, decision.decisionText, decision.decisionDigest,
          execution.sourceSha, execution.runId, execution.runAttempt, execution.githubActorId]);
        await client.query(`INSERT INTO cm_delivery.register_write_receipts (cloud_id, issue_key, version)
          VALUES ($1,$2,$3)`, [...values.slice(0, 2), next.scope.version]);
        return { ...next, state: 'pending', decision, execution, writeClaimed: true };
      });
    },
    readWriteReceipt({ digest, ...binding } = {}) {
      return transaction(binding, async (client, values, current) => {
        if (!current || current.digest !== digest) throw failure();
        const { rows } = await client.query(`SELECT task_id FROM cm_delivery.register_write_receipts
          WHERE cloud_id=$1 AND issue_key=$2 AND version=$3`, [...values.slice(0, 2), current.scope.version]);
        if (rows.length !== 1 || (rows[0].task_id !== null
          && !/^[a-zA-Z0-9-]{1,100}$/.test(rows[0].task_id))) throw failure();
        return { taskId: rows[0].task_id };
      });
    },
    attachWriteReceipt({ digest, taskId, ...binding } = {}) {
      return transaction(binding, async (client, values, current) => {
        if (!current || current.state !== 'pending' || current.digest !== digest
          || typeof taskId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(taskId)) throw failure();
        const result = await client.query(`UPDATE cm_delivery.register_write_receipts SET task_id=$4
          WHERE cloud_id=$1 AND issue_key=$2 AND version=$3 AND (task_id IS NULL OR task_id=$4) RETURNING task_id`,
        [...values.slice(0, 2), current.scope.version, taskId]);
        if (result.rows.length !== 1) throw failure();
        return { taskId: result.rows[0].task_id };
      });
    },
    confirm({ observedScope, ...binding } = {}) {
      return transaction(binding, async (client, values, current) => {
        const observed = canonicalJiraRegister(observedScope);
        if (!current || observed.digest !== current.digest) throw failure();
        if (current.state === 'pending') {
          await client.query(`UPDATE cm_delivery.register_journal SET state='confirmed', confirmed_at=clock_timestamp()
            WHERE cloud_id=$1 AND issue_key=$2 AND version=$3 AND state='pending'`,
          [...values.slice(0, 2), current.scope.version]);
        }
        return { ...current, state: 'confirmed' };
      });
    },
  });
}
