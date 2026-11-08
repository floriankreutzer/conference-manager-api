const failure = () => new Error('JIRA_ISSUE_LOCK_UNVERIFIED');

/** One physical connection owns the issue lock through collection and mutation.
 * Nested journal transactions borrow this connection; releasing a transaction
 * never releases the session lock. Destroying the connection also releases it.
 */
export async function withJiraIssueLock({ pool, cloudId, issueKey, signal } = {}, operation) {
  if (typeof cloudId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(cloudId)
    || typeof issueKey !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(issueKey)
    || typeof operation !== 'function') throw failure();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const key = `cm-jira-register:${cloudId}:${issueKey}`;
  let client;
  let locked = false;
  let failed = false;
  let result;
  const assertActive = () => { if (combined.aborted) throw failure(); };
  const lost = () => controller.abort();
  try {
    assertActive();
    client = await pool.connect();
    client.on?.('error', lost);
    await client.query("SET statement_timeout = '5s'");
    await client.query("SET lock_timeout = '2s'");
    const acquired = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key]);
    locked = acquired.rows.length === 1 && acquired.rows[0].locked === true;
    if (!locked) throw failure();
    assertActive();
    const borrowed = { query: async (...args) => {
      assertActive();
      const value = await client.query(...args);
      assertActive();
      return value;
    }, release: discard => { if (discard) lost(); } };
    result = await operation({ signal: combined, assertActive,
      pool: { connect: async () => { assertActive(); return borrowed; } } });
    assertActive();
  } catch { failed = true; }
  finally {
    if (locked) {
      try {
        const released = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key]);
        if (released.rows.length !== 1 || released.rows[0].unlocked !== true) failed = true;
      } catch { failed = true; }
    }
    controller.abort();
    client?.removeListener?.('error', lost);
    // Never return session-level state or a possibly lost lock to the pool.
    try { client?.release(true); } catch { failed = true; }
  }
  if (failed) throw failure();
  return result;
}
