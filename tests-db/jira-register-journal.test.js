import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';

const binding = { cloudId: '11111111-1111-1111-1111-111111111111', issueKey: 'CO-296', issueId: '10295' };
const entry = number => ({ repository: 'floriankreutzer/conference-manager-api', number, kind: 'delivery' });
const scope = (version, numbers) => ({ schemaVersion: 1, issueKey: binding.issueKey, version, closed: true,
  entries: numbers.map(entry) });
const failure = /^Error: JIRA_REGISTER_JOURNAL_UNVERIFIED$/;

test('real PostgreSQL journal: enrollment, readback, monotonic updates and restart recovery', async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  const sql = await readFile(new URL('../scripts/sql/jira-register-journal-v1.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  const journal = createPostgresJiraRegisterJournal(pool);
  assert.equal(await journal.read(binding), null);

  const first = scope(1, [1]);
  await assert.rejects(journal.prepare({ ...binding, scope: scope(2, [1]) }), failure);
  const exceptions = scope(1, [1]);
  exceptions.entries.push({ repository: 'other/support', number: 1, kind: 'supporting', reason: 'Unanchored decision' });
  await assert.rejects(journal.prepare({ ...binding, scope: exceptions }), failure);
  assert.equal(await journal.read(binding), null, 'failed enrollment rolls back');

  const prepared = await journal.prepare({ ...binding, scope: first });
  assert.equal(prepared.state, 'pending');
  const restarted = createPostgresJiraRegisterJournal(pool);
  assert.deepEqual(await restarted.read(binding), prepared, 'pending intent survives adapter restart');
  assert.deepEqual(await restarted.prepare({ ...binding, scope: first }), prepared, 'duplicate preparation is stable');
  await assert.rejects(restarted.prepare({ ...binding, scope: scope(2, [1, 2]), expectedDigest: prepared.digest }), failure);
  await assert.rejects(restarted.confirm({ ...binding, observedScope: scope(1, [1, 2]) }), failure);
  assert.equal((await restarted.read(binding)).state, 'pending', 'bad readback cannot confirm intent');
  const confirmed = await restarted.confirm({ ...binding, observedScope: first });
  assert.equal(confirmed.state, 'confirmed');
  assert.deepEqual(await restarted.confirm({ ...binding, observedScope: first }), confirmed);

  await t.test('stale versions, wrong anchors, scope shrink and reclassification fail closed', async () => {
    const changed = scope(2, [1, 2]);
    changed.entries[0] = { ...entry(1), kind: 'supporting', reason: 'Unauthorized exclusion' };
    for (const candidate of [scope(1, [1, 2]), scope(3, [1, 2]), scope(2, [2]), scope(2, [1]), changed]) {
      await assert.rejects(journal.prepare({ ...binding, scope: candidate, expectedDigest: confirmed.digest }), failure);
    }
    await assert.rejects(journal.prepare({ ...binding, scope: scope(2, [1, 2]), expectedDigest: 'a'.repeat(64) }), failure);
    assert.deepEqual(await journal.read(binding), confirmed);
  });

  await t.test('concurrent competing updates commit exactly one pending intent', async () => {
    const candidates = [scope(2, [1, 2]), scope(2, [1, 3])];
    const results = await Promise.allSettled(candidates.map(candidate => journal.prepare({ ...binding,
      scope: candidate, expectedDigest: confirmed.digest })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const current = await journal.read(binding);
    assert.equal(current.scope.version, 2);
    assert.equal(current.state, 'pending');
    await assert.rejects(journal.confirm({ ...binding, observedScope: first }), failure, 'old confirmed value is a replay');
    await journal.confirm({ ...binding, observedScope: current.scope });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM cm_delivery.register_journal')).rows[0].count, 2);
  });

  await t.test('issue identities and cloud namespaces cannot alias each other', async () => {
    await assert.rejects(journal.read({ ...binding, issueId: '999' }), failure);
    assert.equal(await journal.read({ ...binding, cloudId: '22222222-2222-2222-2222-222222222222' }), null);
    assert.equal(await journal.read({ ...binding, issueKey: 'CO-297' }), null);
  });

  await t.test('stored scope corruption is detected independently of authenticated database access', async () => {
    const saved = await journal.read(binding);
    await pool.query("UPDATE cm_delivery.register_journal SET digest=$1 WHERE version=2", ['b'.repeat(64)]);
    await assert.rejects(journal.read(binding), failure);
    await pool.query('UPDATE cm_delivery.register_journal SET digest=$1 WHERE version=2', [canonicalJiraRegister(saved.scope).digest]);
  });

  await t.test('migration grants no PUBLIC access and cannot silently replace an existing journal', async () => {
    const { rows } = await pool.query(`SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname='cm_delivery'`);
    assert.ok(!rows[0].acl.includes('=U/'), 'PUBLIC must not have schema USAGE');
    await assert.rejects(pool.query(sql));
    await pool.query('ROLLBACK');
    assert.equal((await journal.read(binding)).scope.version, 2);
  });
});
