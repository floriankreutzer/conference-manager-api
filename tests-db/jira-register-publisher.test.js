import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';
import { publishJiraRegister } from '../scripts/jira-register-publisher.mjs';
import { JIRA_REGISTER_PROPERTY } from '../scripts/jira-register-reader.mjs';

const cloudId = '11111111-1111-1111-1111-111111111111';
const repositories = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const failure = /^Error: JIRA_REGISTER_PUBLISH_UNVERIFIED$/;

function provider(number, options = {}) {
  const issueKey = `CO-${number}`;
  const issueId = String(1000 + number);
  const state = { property: null, puts: 0, tasks: new Map(), taskStatus: 'COMPLETE',
    issueStatus: 'in Review', renamed: false, extraPr: false, githubReads: 0, ...options };
  const config = { cloudId, issueKey, email: 'test@example.invalid', token: 'test-only-jira-token',
    githubToken: 'test-only-github-token' };
  const binding = { cloudId, issueKey, issueId };
  const fetchImpl = async (raw, request) => {
    const url = new URL(raw);
    assert.equal(request.redirect === 'error' || request.redirect === 'manual', true);
    if (url.origin === 'https://api.github.com') {
      state.githubReads++;
      const repository = repositories.find(repo => url.pathname === `/repos/${repo}/pulls`);
      assert.ok(repository);
      const pr = index => ({ number: index, title: state.renamed ? 'Renamed work' : `${issueKey} delivery`,
        draft: true, state: 'open', base: { repo: { full_name: repository } },
        head: { sha: state.drift && state.githubReads > 4 ? 'b'.repeat(40) : 'a'.repeat(40),
          ref: state.renamed ? 'renamed' : `${issueKey}-delivery` } });
      return json(url.searchParams.get('page') === '1' ? [pr(1), ...(state.extraPr ? [pr(2)] : [])] : []);
    }
    assert.equal(url.origin, 'https://api.atlassian.com');
    assert.ok(url.pathname.startsWith(`/ex/jira/${cloudId}/rest/api/3/`));
    if (request.method === 'PUT') {
      state.puts++;
      const body = JSON.parse(request.body);
      assert.deepEqual(body.filter.entityIds, [Number(issueId)], 'never a bulk operation across unrelated issues');
      if (state.conflict) state.property = { ...body.value, version: 99 };
      const eligible = body.filter.hasProperty ? JSON.stringify(body.filter.currentValue) === JSON.stringify(state.property)
        : state.property === null;
      const id = `${number}-${state.puts}`;
      let applied = false;
      const apply = () => {
        if (!applied && eligible) state.property = body.value;
        applied = true;
      };
      state.tasks.set(id, apply);
      if (state.taskStatus === 'COMPLETE') apply();
      if (state.unknownWrite) throw new Error('private transport failure after submission');
      return new Response(null, { status: 303, headers: { location: `https://tenant.atlassian.net/rest/api/3/task/${id}` } });
    }
    assert.equal(request.method, 'GET');
    if (url.pathname.includes('/task/')) {
      const id = url.pathname.split('/').at(-1);
      assert.ok(state.tasks.has(id));
      if (state.taskStatus === 'COMPLETE') state.tasks.get(id)();
      return json({ id, status: state.taskStatus });
    }
    if (url.pathname.includes('/properties/')) {
      return state.property === null ? new Response(null, { status: 404 })
        : json({ key: JIRA_REGISTER_PROPERTY, value: state.property });
    }
    return json({ id: issueId, key: issueKey, fields: { project: { key: 'CO' }, status: { name: state.issueStatus },
      updated: '2026-11-07T10:00:00.000+0000' } });
  };
  return { state, binding, invoke: pool => publishJiraRegister({ ...config, pool, fetchImpl }) };
}

test('PostgreSQL-backed register publisher: conditional writes, durable claims and task recovery', async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  const migration = name => readFile(new URL(`../scripts/sql/${name}`, import.meta.url), 'utf8');
  await pool.query(await migration('jira-register-journal-v1.sql'));
  const journal = createPostgresJiraRegisterJournal(pool);
  const initial = provider(1);
  await assert.rejects(initial.invoke(pool), failure, 'missing receipt schema must roll back enrollment');
  assert.equal(await journal.read(initial.binding), null);
  assert.equal(initial.state.puts, 0);
  await pool.query(await migration('jira-register-write-receipts-v2.sql'));

  await t.test('draft/open obligations are registered, never promoted; duplicate delivery is unchanged', async () => {
    const result = await initial.invoke(pool);
    assert.deepEqual(result, { result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: true, readinessAuthorized: false });
    assert.equal(initial.state.property.entries.length, 2);
    assert.equal((await journal.read(initial.binding)).state, 'confirmed');
    assert.equal((await initial.invoke(pool)).result, 'JIRA_REGISTER_UNCHANGED');
    initial.state.renamed = true;
    assert.equal((await initial.invoke(pool)).result, 'JIRA_REGISTER_UNCHANGED', 'renaming cannot remove obligations');
    assert.equal(initial.state.puts, 1);
    initial.state.renamed = false;
    initial.state.extraPr = true;
    assert.equal((await initial.invoke(pool)).result, 'JIRA_REGISTER_CONFIRMED');
    assert.equal(initial.state.property.version, 2);
    assert.equal(initial.state.property.entries.length, 4);
    assert.equal(initial.state.puts, 2);
  });

  await t.test('a queued task survives restart and is observed without resubmission', async () => {
    const mock = provider(2, { taskStatus: 'RUNNING' });
    assert.equal((await mock.invoke(pool)).result, 'JIRA_REGISTER_TASK_PENDING');
    assert.equal((await journal.read(mock.binding)).state, 'pending');
    assert.equal((await mock.invoke(pool)).result, 'JIRA_REGISTER_TASK_PENDING');
    mock.state.taskStatus = 'COMPLETE';
    assert.deepEqual(await mock.invoke(pool), {
      result: 'JIRA_REGISTER_CONFIRMED', writeSubmitted: false, readinessAuthorized: false,
    });
    assert.equal(mock.state.puts, 1);
  });

  await t.test('an unknown dispatched write is quarantined even if the intended value is visible', async () => {
    const mock = provider(3, { unknownWrite: true });
    await assert.rejects(mock.invoke(pool), failure);
    assert.ok(mock.state.property);
    assert.equal((await journal.read(mock.binding)).state, 'pending');
    mock.state.unknownWrite = false;
    await assert.rejects(mock.invoke(pool), failure);
    assert.equal(mock.state.puts, 1);
  });

  await t.test('provider-side condition conflicts never become a confirmed checkpoint', async () => {
    const mock = provider(4, { conflict: true });
    await assert.rejects(mock.invoke(pool), failure);
    assert.equal(mock.state.property.version, 99, 'concurrent property is not overwritten');
    assert.equal((await journal.read(mock.binding)).state, 'pending');
  });

  await t.test('unanchored properties, changing inventories and Done status cannot trigger writes', async () => {
    const unknown = provider(5, { property: { ...initial.state.property, issueKey: 'CO-5' } });
    await assert.rejects(unknown.invoke(pool), failure);
    const drift = provider(6, { drift: true });
    await assert.rejects(drift.invoke(pool), failure);
    const done = provider(7, { issueStatus: 'Done' });
    assert.equal((await done.invoke(pool)).result, 'JIRA_REGISTER_ISSUE_NOT_IN_REVIEW');
    for (const mock of [unknown, drift, done]) {
      assert.equal(mock.state.puts, 0);
      assert.equal(await journal.read(mock.binding), null);
    }
  });

  await t.test('competing publishers submit at most one provider operation', async () => {
    const mock = provider(8);
    const results = await Promise.allSettled([mock.invoke(pool), mock.invoke(pool)]);
    assert.ok(results.some(result => result.status === 'fulfilled'));
    assert.equal(mock.state.puts, 1);
    assert.equal((await mock.invoke(pool)).result, 'JIRA_REGISTER_UNCHANGED');
    assert.equal(mock.state.puts, 1);
  });

  await t.test('receipt task identity is immutable and stale checkpoints cannot attach a task', async () => {
    const mock = provider(9, { taskStatus: 'RUNNING' });
    await mock.invoke(pool);
    const current = await journal.read(mock.binding);
    await assert.rejects(journal.attachWriteReceipt({ ...mock.binding, digest: current.digest, taskId: 'different' }));
    await assert.rejects(journal.attachWriteReceipt({ ...mock.binding, digest: 'a'.repeat(64), taskId: '1' }));
    assert.deepEqual(await journal.readWriteReceipt({ ...mock.binding, digest: current.digest }), { taskId: '9-1' });
    const other = provider(11, { unknownWrite: true });
    await assert.rejects(other.invoke(pool), failure);
    const otherCurrent = await journal.read(other.binding);
    await assert.rejects(journal.attachWriteReceipt({ ...other.binding, digest: otherCurrent.digest, taskId: '9-1' }));
    assert.deepEqual(await journal.readWriteReceipt({ ...other.binding, digest: otherCurrent.digest }), { taskId: null });
  });

  await t.test('publisher runs with column-limited grants and cannot modify scope history or read customer tables', async () => {
    const role = `cm_jira_writer_${process.pid}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    try {
      await pool.query(`GRANT USAGE ON SCHEMA cm_delivery TO ${role}`);
      await pool.query(`GRANT SELECT, INSERT ON cm_delivery.register_journal, cm_delivery.register_write_receipts TO ${role}`);
      await pool.query(`GRANT UPDATE (state, confirmed_at) ON cm_delivery.register_journal TO ${role}`);
      await pool.query(`GRANT UPDATE (task_id) ON cm_delivery.register_write_receipts TO ${role}`);
      await pool.query('CREATE TABLE public.jira_customer_boundary_fixture (id integer)');
      const limitedPool = { connect: async () => {
        const client = await pool.connect();
        try { await client.query(`SET ROLE ${role}`); } catch (error) { client.release(true); throw error; }
        return { query: client.query.bind(client), release: () => client.release(true) };
      } };
      const mock = provider(10);
      assert.equal((await mock.invoke(limitedPool)).result, 'JIRA_REGISTER_CONFIRMED');
      mock.state.extraPr = true;
      assert.equal((await mock.invoke(limitedPool)).result, 'JIRA_REGISTER_CONFIRMED');
      const client = await limitedPool.connect();
      try {
        for (const sql of ["UPDATE cm_delivery.register_journal SET scope='{}'::jsonb",
          'DELETE FROM cm_delivery.register_journal', 'DROP TABLE cm_delivery.register_journal',
          'SELECT * FROM public.jira_customer_boundary_fixture']) {
          await assert.rejects(client.query(sql), error => error.code === '42501');
        }
      } finally { client.release(); }
    } finally {
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});
