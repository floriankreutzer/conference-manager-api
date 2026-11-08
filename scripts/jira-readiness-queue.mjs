const failure = () => new Error('JIRA_READINESS_QUEUE_UNVERIFIED');
const key = value => typeof value === 'string' && /^CO-[1-9][0-9]{0,8}$/.test(value);
const number = value => Number(value.slice(3));

/** Fair, bounded scheduling only. A cursor advance never authorizes mutation or establishes execution success. */
export async function selectJiraReadinessBatch({ pool, cloudId, candidates } = {}) {
  let client; let discard = false;
  try {
    if (typeof cloudId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(cloudId)
      || !Array.isArray(candidates) || candidates.length > 1000 || !candidates.every(key)
      || new Set(candidates).size !== candidates.length) throw failure();
    client = await pool.connect(); await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'"); await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cm-jira-readiness-sweep:${cloudId}`]);
    // A successful remote mutation may already have removed the issue from the JQL candidate status.
    const pending = await client.query(`SELECT issue_key FROM cm_delivery.register_journal
      WHERE cloud_id=$1 AND state='pending' UNION SELECT issue_key FROM cm_delivery.transition_journal
      WHERE cloud_id=$1 AND state='pending' LIMIT 1001`, [cloudId]);
    if (pending.rows.length > 1000 || pending.rows.some(row => !key(row.issue_key))) throw failure();
    const keys = [...new Set([...candidates, ...pending.rows.map(row => row.issue_key)])].sort((a, b) => number(a) - number(b));
    if (keys.length > 1000) throw failure();
    const current = await client.query('SELECT last_issue_key FROM cm_delivery.readiness_sweep_cursor WHERE cloud_id=$1', [cloudId]);
    if (current.rows.length > 1 || (current.rows.length && !key(current.rows[0].last_issue_key))) throw failure();
    const after = current.rows.length ? number(current.rows[0].last_issue_key) : 0;
    const selected = [...keys.filter(value => number(value) > after), ...keys.filter(value => number(value) <= after)].slice(0, 5);
    if (selected.length) {
      await client.query(`INSERT INTO cm_delivery.readiness_sweep_cursor (cloud_id,last_issue_key) VALUES ($1,$2)
        ON CONFLICT (cloud_id) DO UPDATE SET last_issue_key=EXCLUDED.last_issue_key,updated_at=clock_timestamp()`,
      [cloudId, selected.at(-1)]);
    }
    await client.query('COMMIT');
    return { issueKeys: selected, queueSize: keys.length };
  } catch {
    if (client) { try { await client.query('ROLLBACK'); } catch { discard = true; } }
    throw failure();
  } finally { client?.release(discard); }
}
