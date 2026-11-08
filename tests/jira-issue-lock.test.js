import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { withJiraIssueLock } from '../scripts/jira-issue-lock.mjs';

const binding = { cloudId: '11111111-1111-1111-1111-111111111111', issueKey: 'CO-296' };
const failure = { message: 'JIRA_ISSUE_LOCK_UNVERIFIED' };
function harness({ busy = false, unlockFailure = false } = {}) {
  const client = new EventEmitter();
  const calls = [];
  client.query = async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !busy }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: !unlockFailure }] };
    return { rows: [] };
  };
  client.release = discard => calls.push({ discard });
  return { client, calls, pool: { connect: async () => client } };
}
test('one physical connection retains the issue lock across nested transactions and HTTP work', async () => {
  const h = harness();
  const value = await withJiraIssueLock({ ...binding, pool: h.pool }, async lease => {
    const a = await lease.pool.connect();
    await a.query('BEGIN'); await a.query('COMMIT'); a.release(false);
    const b = await lease.pool.connect();
    assert.equal(a, b);
    assert.equal(h.calls.some(call => call.sql?.includes('pg_advisory_unlock')), false);
    assert.equal(lease.signal.aborted, false);
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual(h.calls.at(-1), { discard: true });
  assert.equal(h.client.listenerCount('error'), 0);
  assert.equal(h.calls.filter(call => call.sql?.includes('pg_try_advisory_lock')).length, 1);
  assert.equal(h.calls[2].values[0], `cm-jira-register:${binding.cloudId}:${binding.issueKey}`);
});
test('busy locks and uncertain unlocks cannot report successful work', async () => {
  for (const mode of [{ busy: true }, { unlockFailure: true }]) {
    const h = harness(mode);
    let called = false;
    await assert.rejects(withJiraIssueLock({ ...binding, pool: h.pool }, async () => { called = true; }), failure);
    assert.equal(called, !mode.busy);
    assert.deepEqual(h.calls.at(-1), { discard: true });
  }
});
test('connection loss, transaction discard and caller abort cancel work without releasing authority early', async () => {
  for (const event of ['connection', 'discard', 'abort']) {
    const h = harness();
    const controller = new AbortController();
    await assert.rejects(withJiraIssueLock({ ...binding, pool: h.pool, signal: controller.signal }, async lease => {
      const client = await lease.pool.connect();
      if (event === 'connection') h.client.emit('error', new Error('private provider message'));
      if (event === 'discard') client.release(true);
      if (event === 'abort') controller.abort();
      assert.equal(lease.signal.aborted, true);
      await assert.rejects(client.query('must not execute'), failure);
      lease.assertActive();
    }), failure);
    assert.equal(h.calls.some(call => call.sql === 'must not execute'), false);
    assert.deepEqual(h.calls.at(-1), { discard: true });
  }
});
test('invalid bindings and pre-aborted calls perform no database work', async () => {
  for (const change of [{ issueKey: 'FOREIGN-1' }, { cloudId: 'untrusted' }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(withJiraIssueLock({ ...binding, ...change,
      pool: { connect: () => assert.fail('must not connect') } }, () => assert.fail('must not execute')), failure);
  }
});
