import { randomUUID } from 'node:crypto';

const failure = () => new Error('JIRA_TRANSITION_JOURNAL_UNVERIFIED');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const matches = (value, expression) => typeof value === 'string' && expression.test(value);
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));

function target({ cloudId, issueKey, issueId } = {}) {
  if (!matches(cloudId, UUID) || !matches(issueKey, /^CO-[1-9][0-9]{0,8}$/)
    || !matches(issueId, ID)) throw failure();
  return [cloudId, issueKey, issueId];
}

function intent(value) {
  if (!value || !matches(value.decisionKey, HASH) || !matches(value.registerDigest, HASH)
    || !Number.isSafeInteger(value.registerVersion) || value.registerVersion < 1
    || !matches(value.actorId, /^[a-zA-Z0-9:-]{1,128}$/)
    || !matches(value.transitionId, ID) || !matches(value.sourceStatusId, ID)
    || !matches(value.targetStatusId, ID) || value.sourceStatusId === value.targetStatusId
    || !timestamp(value.issueUpdatedAt)) throw failure();
  return value;
}

function decode(row, binding) {
  if (!row) return null;
  const value = intent({ decisionKey: row.decision_key, registerDigest: row.register_digest,
    registerVersion: row.register_version, actorId: row.actor_id, transitionId: row.transition_id,
    sourceStatusId: row.source_status_id, targetStatusId: row.target_status_id,
    issueUpdatedAt: row.issue_updated_at instanceof Date ? row.issue_updated_at.toISOString() : row.issue_updated_at });
  if (row.issue_id !== binding.issueId || !matches(row.attempt_id, UUID)
    || !['pending', 'confirmed'].includes(row.state)
    || !(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())
    || (row.state === 'pending' && (row.history_id !== null || row.confirmed_at !== null))
    || (row.state === 'confirmed' && (!matches(row.history_id, ID)
      || !(row.confirmed_at instanceof Date) || !Number.isFinite(row.confirmed_at.getTime())))) throw failure();
  return { ...value, attemptId: row.attempt_id, state: row.state,
    createdAt: row.created_at.toISOString(), historyId: row.history_id };
}

/** Durable one-shot claims. An existing pending record never authorizes a retry. */
export function createPostgresJiraTransitionJournal(pool) {
  async function transaction(binding, operation) {
    const values = target(binding);
    let client;
    let discard = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`cm-jira-register:${values[0]}:${values[1]}`]);
      const result = await operation(client, values);
      await client.query('COMMIT');
      return result;
    } catch {
      if (client) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
      throw failure();
    } finally { client?.release(discard); }
  }
  return Object.freeze({
    pending(binding) {
      return transaction(binding, async (client, values) => {
        const result = await client.query(`SELECT * FROM cm_delivery.transition_journal
          WHERE cloud_id=$1 AND issue_key=$2 AND state='pending' LIMIT 2`, values.slice(0, 2));
        if (result.rows.length > 1) throw failure();
        return decode(result.rows[0], binding);
      });
    },
    claim({ decision, ...binding } = {}) {
      return transaction(binding, async (client, values) => {
        const next = intent(decision);
        const existing = await client.query(`SELECT * FROM cm_delivery.transition_journal
          WHERE cloud_id=$1 AND issue_key=$2 AND (state='pending' OR decision_key=$3)
          ORDER BY CASE WHEN state='pending' THEN 0 ELSE 1 END LIMIT 1`,
        [...values.slice(0, 2), next.decisionKey]);
        if (existing.rows.length) return { attempt: decode(existing.rows[0], binding), claimed: false };
        const current = await client.query(`SELECT issue_id, version, digest, state FROM cm_delivery.register_journal
          WHERE cloud_id=$1 AND issue_key=$2 ORDER BY version DESC LIMIT 1`, values.slice(0, 2));
        const register = current.rows[0];
        if (current.rows.length !== 1 || register.issue_id !== binding.issueId || register.state !== 'confirmed'
          || register.version !== next.registerVersion || register.digest !== next.registerDigest) throw failure();
        const inserted = await client.query(`INSERT INTO cm_delivery.transition_journal
          (cloud_id, issue_key, issue_id, decision_key, attempt_id, register_version, register_digest,
          actor_id, transition_id, source_status_id, target_status_id, issue_updated_at, state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING *`,
        [...values, next.decisionKey, randomUUID(), next.registerVersion, next.registerDigest,
          next.actorId, next.transitionId, next.sourceStatusId, next.targetStatusId, next.issueUpdatedAt]);
        if (inserted.rows.length !== 1) throw failure();
        return { attempt: decode(inserted.rows[0], binding), claimed: true };
      });
    },
    confirm({ decisionKey, attemptId, historyId, ...binding } = {}) {
      return transaction(binding, async (client, values) => {
        if (!matches(decisionKey, HASH) || !matches(attemptId, UUID) || !matches(historyId, ID)) throw failure();
        const updated = await client.query(`UPDATE cm_delivery.transition_journal
          SET state='confirmed', history_id=$6, confirmed_at=COALESCE(confirmed_at,clock_timestamp())
          WHERE cloud_id=$1 AND issue_key=$2 AND issue_id=$3 AND decision_key=$4 AND attempt_id=$5
          AND (history_id IS NULL OR history_id=$6) RETURNING *`, [...values, decisionKey, attemptId, historyId]);
        if (updated.rows.length !== 1) throw failure();
        return decode(updated.rows[0], binding);
      });
    },
  });
}
