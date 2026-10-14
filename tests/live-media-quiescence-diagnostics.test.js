import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoOtherDatabaseSessions } from '../scripts/support/live-media-operator-db.mjs';

const quiet = { other_sessions: '0', prepared_transactions: '0', own_session: '1',
  other_active: '0', other_idle: '0', other_in_transaction: '0', other_operator: '0', other_same_role: '0' };

function client(row, queries) {
  return { query: async (sql) => { queries.push(sql); return { rows: sql.includes('pg_stat_clear_snapshot') ? [] : [row] }; } };
}

test('quiescence diagnosis emits only validated numeric counters and preserves the guard', async () => {
  for (const [changes, blocked] of [[{}, false], [{ other_sessions: '1', other_idle: '1' }, true],
    [{ prepared_transactions: '1' }, true], [{ own_session: '0' }, true],
    [{ other_sessions: '1', other_operator: '1', other_same_role: '1' }, true],
    [{ other_sessions: '1' }, true]]) {
    const queries = [];
    const observations = [];
    const row = { ...quiet, ...changes, query: 'private query', client_addr: 'private address', password: 'private password' };
    const action = assertNoOtherDatabaseSessions(client(row, queries), (value) => observations.push(value));
    if (blocked) await assert.rejects(action, { code: 'LIVE_MEDIA_DATABASE_NOT_QUIESCENT' });
    else await action;
    assert.equal(observations.length, 1);
    assert.deepEqual(Object.keys(observations[0]), Object.keys(quiet));
    assert.ok(Object.isFrozen(observations[0]));
    assert.ok(Object.values(observations[0]).every(Number.isSafeInteger));
    assert.equal(JSON.stringify(observations).includes('private'), false);
    assert.equal(queries.length, 2);
    assert.equal(queries[0], 'SELECT pg_stat_clear_snapshot()');
    assert.equal(queries.some((sql) => /pg_terminate_backend|pg_cancel_backend|DELETE|UPDATE|INSERT|GRANT/.test(sql)), false);
  }
});

test('malformed or inconsistent counters fail before any diagnostic publication', async () => {
  for (const changes of [{ other_sessions: '-1' }, { own_session: null }, { other_idle: 'private' },
    { other_active: '1' }, { other_sessions: '1', other_active: '1', other_idle: '1' },
    { other_operator: Number.MAX_SAFE_INTEGER + 1 }]) {
    const observations = [];
    await assert.rejects(assertNoOtherDatabaseSessions(client({ ...quiet, ...changes }, []),
      (value) => observations.push(value)));
    assert.equal(observations.length, 0);
  }
});
