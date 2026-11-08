import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';
import { createPostgresJiraTransitionJournal } from '../scripts/jira-transition-journal.mjs';
import { promoteJiraReadiness } from '../scripts/jira-readiness-promoter.mjs';
import { publishJiraRegister } from '../scripts/jira-register-publisher.mjs';
import { fixture, transport } from '../tests/support/jira-readiness-fixture.mjs';

const failure = { message: 'JIRA_READINESS_PROMOTION_UNVERIFIED' };
test('real PostgreSQL transition composition and durable restart recovery', async t => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  t.after(() => pool.end());
  for (const name of ['jira-register-journal-v1', 'jira-register-write-receipts-v2', 'jira-transition-journal-v3']) {
    await pool.query(await readFile(new URL(`../scripts/sql/${name}.sql`, import.meta.url), 'utf8'));
  }
  let nextKey = 500;
  const make = async () => {
    const f = fixture(`CO-${++nextKey}`);
    const binding = { cloudId: f.options.cloudId, issueKey: f.options.issueKey, issueId: f.issue.id };
    const journal = createPostgresJiraRegisterJournal(pool);
    await journal.prepare({ ...binding, scope: f.scope });
    await journal.confirm({ ...binding, observedScope: f.scope });
    return { f, binding };
  };
  const run = (f, extra = {}, mutate) => promoteJiraReadiness({ ...f.options, pool, ...transport(f, mutate), ...extra });
  const pending = binding => createPostgresJiraTransitionJournal(pool).pending(binding);

  await t.test('all merged and current gates promote once; duplicates and return to Review cannot repeat the decision', async () => {
    const { f } = await make();
    assert.deepEqual(await run(f), { result: 'JIRA_READINESS_TRANSITION_CONFIRMED',
      transitionSubmitted: true, transitionConfirmed: true, atTarget: true });
    assert.equal(f.posts, 1);
    assert.equal((await run(f)).result, 'JIRA_READINESS_ISSUE_NOT_IN_REVIEW');
    f.issue.fields.status = { id: '10004', name: 'in Review' };
    assert.equal((await run(f)).result, 'JIRA_READINESS_ALREADY_CONFIRMED');
    assert.equal(f.posts, 1);
    assert.equal(f.issue.fields.status.name, 'in Review');
  });
  for (const [name, change] of Object.entries({
    draftOnly: f => { for (const pr of f.prs) Object.assign(pr, { draft: true, state: 'open', merged: false, merged_at: null }); },
    partialMergeDraft: f => { Object.assign(f.prs[1], { draft: true, state: 'open', merged: false, merged_at: null }); },
    partialMergeOpen: f => { Object.assign(f.prs[1], { state: 'open', merged: false, merged_at: null }); },
    closedUnmerged: f => { f.prs[1].merged = false; f.prs[1].merged_at = null; },
    pendingCheck: f => { f.checkStatus = 'queued'; f.checkConclusion = null; },
    failedCheck: f => { f.checkConclusion = 'failure'; },
    unresolvedReview: f => { f.unresolved = true; },
  })) {
    await t.test(`${name} keeps the issue in Review and creates no transition intent`, async () => {
      const { f, binding } = await make(); change(f);
      assert.equal((await run(f)).result, 'JIRA_READINESS_GATES_BLOCKED');
      assert.equal(f.posts, 0); assert.equal(f.issue.fields.status.name, 'in Review');
      assert.equal(await pending(binding), null);
    });
  }
  await t.test('no association, unanchored scope and deleted register do not acquire authority', async () => {
    for (const change of [f => { f.scope = null; f.prs = []; }, f => { f.scope.version++; }, f => { f.scope = null; }]) {
      const { f, binding } = await make(); change(f);
      await assert.rejects(run(f), failure);
      assert.equal(f.posts, 0); assert.equal(await pending(binding), null);
    }
  });
  await t.test('Product Acceptance Pending or Rejected can never result in Done', async () => {
    for (const acceptance of ['Pending', 'Rejected']) {
      const { f } = await make(); f.issue.fields.productAcceptance = acceptance;
      assert.equal((await run(f)).atTarget, true);
      assert.equal(f.issue.fields.status.name, 'Ready for Deployment');
      assert.equal(f.issue.fields.productAcceptance, acceptance);
      assert.equal((await run(f)).transitionSubmitted, false);
      assert.equal(f.posts, 1);
    }
  });
  await t.test('source drift before dispatch blocks without a claim or POST', async () => {
    const { f, binding } = await make();
    await assert.rejects(run(f, {}, (state, url, calls) => {
      if (url.endsWith('?fields=status') && calls.filter(call => call.url.endsWith('?fields=status')).length === 2) {
        state.issue.fields.status.name = 'Done';
      }
    }), failure);
    assert.equal(f.posts, 0); assert.equal(await pending(binding), null);
  });
  await t.test('concurrent invocations have one physical lock owner and at most one POST', async () => {
    const { f } = await make();
    const results = await Promise.allSettled([run(f), run(f)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.posts, 1);
  });
  await t.test('register publication and transition collection respect the same physical issue lock', async () => {
    const { f, binding } = await make(); const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',
        [`cm-jira-register:${binding.cloudId}:${binding.issueKey}`]);
      const options = { ...f.options, pool, fetchImpl: () => assert.fail('no HTTP while another writer owns the lock') };
      await assert.rejects(promoteJiraReadiness(options), failure);
      await assert.rejects(publishJiraRegister(options), { message: 'JIRA_REGISTER_PUBLISH_UNVERIFIED' });
    } finally { client.release(true); }
    assert.equal(f.posts, 0);
  });
  await t.test('restart observes a confirmed remote POST even after Jira left the candidate status', async () => {
    const { f, binding } = await make();
    assert.equal((await run(f, { deferConfirmation: true })).result, 'JIRA_READINESS_TRANSITION_PENDING');
    assert.equal((await pending(binding)).state, 'pending');
    assert.equal(f.issue.fields.status.name, 'Ready for Deployment');
    assert.deepEqual(await run(f), { result: 'JIRA_READINESS_TRANSITION_CONFIRMED',
      transitionSubmitted: false, transitionConfirmed: true, atTarget: true });
    assert.equal(await pending(binding), null); assert.equal(f.posts, 1);
  });
  await t.test('unknown POST outcome is recovered using immutable history without resubmission', async () => {
    const { f, binding } = await make(); f.unknownPost = true;
    await assert.rejects(run(f), failure);
    const original = await pending(binding); assert.equal(original.state, 'pending');
    assert.equal((await run(f)).transitionConfirmed, true);
    assert.equal(f.posts, 1); assert.equal(await pending(binding), null);
  });
  await t.test('large description histories recover the same durable attempt without another POST', async () => {
    const { f, binding } = await make();
    f.histories = Array.from({ length: 54 }, (_, i) => ({ id: String(i + 1),
      items: [{ field: 'description', fromString: 'x'.repeat(30000), toString: 'y'.repeat(30000) }] }));
    await run(f, { deferConfirmation: true });
    const original = await pending(binding);
    assert.deepEqual(await run(f), { result: 'JIRA_READINESS_TRANSITION_CONFIRMED',
      transitionSubmitted: false, transitionConfirmed: true, atTarget: true });
    const confirmed = await pool.query(`SELECT attempt_id, state, history_id FROM cm_delivery.transition_journal
      WHERE cloud_id=$1 AND issue_key=$2`, [binding.cloudId, binding.issueKey]);
    assert.deepEqual(confirmed.rows, [{ attempt_id: original.attemptId, state: 'confirmed', history_id: '55' }]);
    assert.equal(await pending(binding), null); assert.equal(f.posts, 1);
  });
  await t.test('a rejected POST remains quarantined; a new adapter cannot infer safe replay from current status', async () => {
    const { f, binding } = await make(); f.rejectPost = true;
    await assert.rejects(run(f), failure); const original = await pending(binding);
    f.rejectPost = false;
    assert.equal((await run(f)).result, 'JIRA_READINESS_TRANSITION_PENDING');
    assert.deepEqual(await pending(binding), original);
    assert.equal(f.posts, 1); assert.equal(f.issue.fields.status.name, 'in Review');
  });
  await t.test('wrong history actor never confirms a pending intent or resubmits', async () => {
    const { f, binding } = await make();
    await run(f, { deferConfirmation: true }); f.histories[0].author.accountId = 'other-principal';
    await assert.rejects(run(f), failure);
    assert.equal((await pending(binding)).state, 'pending'); assert.equal(f.posts, 1);
  });
  await t.test('unknown database claim COMMIT leaves durable quarantine without dispatch permission on restart', async () => {
    const { f, binding } = await make();
    const uncertain = { connect: async () => {
      const client = await pool.connect(); let inserted = false;
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client),
        release: client.release.bind(client), query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (sql.startsWith('INSERT INTO cm_delivery.transition_journal')) inserted = true;
          if (sql === 'COMMIT' && inserted) { inserted = false; throw new Error('private connection lost after commit'); }
          return result;
        } };
    } };
    await assert.rejects(run(f, { pool: uncertain }), failure);
    assert.equal((await pending(binding)).state, 'pending'); assert.equal(f.posts, 0);
    assert.equal((await run(f)).result, 'JIRA_READINESS_TRANSITION_PENDING');
    assert.equal(f.posts, 0);
  });
  await t.test('writer column privileges preserve intent identity and deny DDL, deletion and customer access', async () => {
    const role = `transition_test_${process.pid}`;
    const { f } = await make(); await run(f, { deferConfirmation: true });
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA cm_delivery TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE(state,history_id,confirmed_at) ON cm_delivery.transition_journal TO ${role}`);
    await pool.query('CREATE TABLE public.synthetic_customer_secret (value text)');
    const client = await pool.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      assert.ok((await client.query('SELECT attempt_id FROM cm_delivery.transition_journal')).rows.length > 0);
      for (const sql of ["UPDATE cm_delivery.transition_journal SET decision_key=repeat('d',64)",
        "UPDATE cm_delivery.transition_journal SET actor_id='foreign'", 'DELETE FROM cm_delivery.transition_journal',
        'CREATE TABLE cm_delivery.untrusted (value text)', 'SELECT * FROM public.synthetic_customer_secret']) {
        await assert.rejects(client.query(sql), error => error.code === '42501');
      }
    } finally { await client.query('RESET ROLE'); client.release(); }
    const publicAcl = await pool.query(`SELECT acl.privilege_type FROM pg_class relation,
      LATERAL aclexplode(relation.relacl) acl WHERE relation.oid='cm_delivery.transition_journal'::regclass AND acl.grantee=0`);
    assert.deepEqual(publicAcl.rows, []);
    await pool.query(`DROP OWNED BY ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  });
});
