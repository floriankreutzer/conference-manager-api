import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { selectJiraReadinessBatch } from '../scripts/jira-readiness-queue.mjs';
import { createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';
import { createPostgresJiraTransitionJournal } from '../scripts/jira-transition-journal.mjs';
import { promoteJiraReadiness } from '../scripts/jira-readiness-promoter.mjs';
import { reconcileJiraReadinessIssue } from '../scripts/jira-readiness-write.mjs';
import { fixture, transport, options } from '../tests/support/jira-readiness-fixture.mjs';

const failure = { message: 'JIRA_READINESS_QUEUE_UNVERIFIED' };
test('real PostgreSQL fair queue and post-transition recovery discovery', async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  for (const name of ['jira-register-journal-v1', 'jira-register-write-receipts-v2',
    'jira-transition-journal-v3', 'jira-readiness-sweep-v4']) {
    await pool.query(await readFile(new URL(`../scripts/sql/${name}.sql`, import.meta.url), 'utf8'));
  }
  const select = (candidates, cloudId = options.cloudId) => selectJiraReadinessBatch({ pool, cloudId, candidates });
  const candidates = Array.from({ length: 12 }, (_, i) => `CO-${i + 1}`);
  assert.deepEqual(await select([]), { issueKeys: [], queueSize: 0 });
  assert.deepEqual((await select(candidates)).issueKeys, candidates.slice(0, 5));
  assert.deepEqual((await select(candidates)).issueKeys, candidates.slice(5, 10));
  assert.deepEqual((await select(candidates)).issueKeys, [...candidates.slice(10), ...candidates.slice(0, 3)]);
  assert.deepEqual((await select(candidates, '22222222-2222-2222-2222-222222222222')).issueKeys, candidates.slice(0, 5));

  await t.test('concurrent schedulers advance the cursor transactionally without repeatedly selecting the same first page', async () => {
    const cloudId = '33333333-3333-3333-3333-333333333333';
    const batches = await Promise.all([select(candidates, cloudId), select(candidates, cloudId)]);
    assert.equal(new Set(batches.flatMap(batch => batch.issueKeys)).size, 10);
  });
  await t.test('a successful remote transition is discovered from durable pending work after it leaves in Review', async () => {
    const f = fixture('CO-700'); const binding = { cloudId: options.cloudId, issueKey: f.options.issueKey, issueId: f.issue.id };
    const journal = createPostgresJiraRegisterJournal(pool);
    await journal.prepare({ ...binding, scope: f.scope }); await journal.confirm({ ...binding, observedScope: f.scope });
    await promoteJiraReadiness({ ...f.options, pool, ...transport(f), deferConfirmation: true });
    assert.equal(f.issue.fields.status.name, 'Ready for Deployment');
    const batch = await select([]); assert.deepEqual(batch, { issueKeys: ['CO-700'], queueSize: 1 });
    const result = await reconcileJiraReadinessIssue({ ...f.options, issueKey: batch.issueKeys[0], pool, ...transport(f) });
    assert.equal(result.transitionConfirmed, true); assert.equal(result.transitionSubmitted, false); assert.equal(f.posts, 1);
    assert.equal(await createPostgresJiraTransitionJournal(pool).pending(binding), null);
    assert.deepEqual(await select([]), { issueKeys: [], queueSize: 0 });
  });
  await t.test('pending register tasks are also discovered independently and cannot starve new candidates', async () => {
    const f = fixture('CO-701');
    await createPostgresJiraRegisterJournal(pool).prepare({ cloudId: options.cloudId, issueKey: 'CO-701',
      issueId: f.issue.id, scope: f.scope });
    assert.deepEqual((await select([])).issueKeys, ['CO-701']);
    const visited = new Set();
    for (let run = 0; run < 3; run++) for (const key of (await select(candidates)).issueKeys) visited.add(key);
    assert.deepEqual([...visited].sort(), [...candidates, 'CO-701'].sort());
  });
  await t.test('invalid, duplicate or oversized input leaves the scheduling cursor unchanged', async () => {
    const before = (await pool.query('SELECT * FROM cm_delivery.readiness_sweep_cursor ORDER BY cloud_id')).rows;
    for (const invalid of [['OTHER-1'], ['CO-1', 'CO-1'], Array.from({ length: 1001 }, (_, i) => `CO-${i + 1}`)]) {
      await assert.rejects(select(invalid), failure);
    }
    assert.deepEqual((await pool.query('SELECT * FROM cm_delivery.readiness_sweep_cursor ORDER BY cloud_id')).rows, before);
  });
  await t.test('cursor grants expose only scheduling state, without DDL, deletion or cloud reassignment', async () => {
    const role = `sweep_test_${process.pid}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA cm_delivery TO ${role}`);
    await pool.query(`GRANT SELECT,INSERT,UPDATE(last_issue_key,updated_at) ON cm_delivery.readiness_sweep_cursor TO ${role}`);
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      assert.ok((await client.query('SELECT last_issue_key FROM cm_delivery.readiness_sweep_cursor')).rows.length > 0);
      for (const sql of ["UPDATE cm_delivery.readiness_sweep_cursor SET cloud_id='44444444-4444-4444-4444-444444444444'",
        'DELETE FROM cm_delivery.readiness_sweep_cursor', 'CREATE TABLE cm_delivery.untrusted_cursor (value text)']) {
        await assert.rejects(client.query(sql), error => error.code === '42501');
      }
    } finally { await client.query('RESET ROLE'); client.release(); }
    await pool.query(`DROP OWNED BY ${role}`); await pool.query(`DROP ROLE ${role}`);
    const acl = await pool.query(`SELECT acl.privilege_type FROM pg_class relation,
      LATERAL aclexplode(relation.relacl) acl WHERE relation.oid='cm_delivery.readiness_sweep_cursor'::regclass AND acl.grantee=0`);
    assert.deepEqual(acl.rows, []);
  });
});
