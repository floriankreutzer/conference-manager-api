import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Pool } from 'pg';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';
import { deriveJiraScopeRevision } from '../scripts/jira-register-scope-revision.mjs';
import { reviseJiraRegisterScope } from '../scripts/jira-register-reviser.mjs';
import { publishJiraRegister } from '../scripts/jira-register-publisher.mjs';
import { withJiraIssueLock } from '../scripts/jira-issue-lock.mjs';
import { createPostgresJiraTransitionJournal } from '../scripts/jira-transition-journal.mjs';
import { actorId, decisionComment, execution, makeDecision, reference,
  scopeRevisionProvider } from '../tests/support/jira-scope-revision-fixture.mjs';

const rejected = /^Error: JIRA_SCOPE_REVISION_PUBLISH_UNVERIFIED$/;
const journalRejected = /^Error: JIRA_REGISTER_JOURNAL_UNVERIFIED$/;

test('PostgreSQL scope revision: immutable authority, conditional writes, least privilege and no replay', async t => {
  const owner = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000 });
  let operator;
  let roleCreated = false;
  t.after(async () => {
    await operator?.end();
    if (roleCreated) {
      await owner.query('DROP OWNED BY cm_scope_revision_writer_test');
      await owner.query('DROP ROLE cm_scope_revision_writer_test');
    }
    await owner.end();
  });
  const migration = name => readFile(new URL(`../scripts/sql/${name}`, import.meta.url), 'utf8');
  await owner.query(await migration('jira-register-journal-v1.sql'));
  await owner.query(await migration('jira-register-write-receipts-v2.sql'));
  await owner.query(await migration('jira-transition-journal-v3.sql'));
  const ownerJournal = createPostgresJiraRegisterJournal(owner);
  const missingSchema = scopeRevisionProvider(800);
  await ownerJournal.prepare({ ...missingSchema.target, scope: missingSchema.original.scope });
  await ownerJournal.confirm({ ...missingSchema.target, observedScope: missingSchema.original.scope });
  await assert.rejects(ownerJournal.prepareScopeRevision({ ...missingSchema.target,
    decision: missingSchema.proof, execution }), journalRejected, 'unprovisioned v5 cannot create an intent');
  assert.deepEqual(await ownerJournal.read(missingSchema.target), missingSchema.original);
  await owner.query(await migration('jira-register-scope-revisions-v5.sql'));
  await owner.query(`CREATE ROLE cm_scope_revision_writer_test NOLOGIN NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  roleCreated = true;
  await owner.query('GRANT USAGE ON SCHEMA cm_delivery TO cm_scope_revision_writer_test');
  await owner.query(`GRANT SELECT, INSERT, UPDATE(state, confirmed_at)
    ON cm_delivery.register_journal TO cm_scope_revision_writer_test`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE(task_id)
    ON cm_delivery.register_write_receipts TO cm_scope_revision_writer_test`);
  await owner.query('GRANT SELECT, INSERT ON cm_delivery.register_scope_revisions TO cm_scope_revision_writer_test');
  await owner.query('GRANT SELECT ON cm_delivery.transition_journal TO cm_scope_revision_writer_test');
  operator = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, connectionTimeoutMillis: 5000,
    options: '-c role=cm_scope_revision_writer_test' });
  const journal = createPostgresJiraRegisterJournal(operator);
  const enroll = async number => {
    const fixture = scopeRevisionProvider(number);
    await journal.prepare({ ...fixture.target, scope: fixture.original.scope });
    await journal.confirm({ ...fixture.target, observedScope: fixture.original.scope });
    return fixture;
  };
  const invoke = (fixture, changes = {}) => reviseJiraRegisterScope({ ...fixture.options, pool: operator, ...changes });
  const provenance = fixture => journal.readScopeRevision({ ...fixture.target, commentId: fixture.proof.commentId,
    expectedDecisionDigest: fixture.proof.decisionDigest, actorId });

  await t.test('revision uses the restricted role and commits source, decision and one receipt together', async () => {
    const fixture = await enroll(801);
    assert.deepEqual(await invoke(fixture), {
      result: 'JIRA_SCOPE_REVISION_CONFIRMED', writeSubmitted: true, readinessAuthorized: false,
    });
    const saved = await provenance(fixture);
    assert.equal(saved.state, 'confirmed');
    assert.deepEqual(saved.decision, fixture.proof);
    assert.deepEqual(saved.execution, execution);
    assert.equal(saved.scope.version, 2);
    assert.equal(saved.scope.entries.find(entry => entry.number === 1).kind, 'superseded');
    assert.equal(saved.scope.entries.find(entry => entry.number === 2).kind, 'delivery', 'unrelated API obligation retained');
    assert.equal(fixture.state.puts.length, 1);
    assert.deepEqual(fixture.state.puts[0].filter.currentValue, fixture.original.scope);
    const prior = await owner.query(`SELECT scope FROM cm_delivery.register_journal
      WHERE issue_key=$1 AND version=1`, [fixture.target.issueKey]);
    assert.deepEqual(prior.rows[0].scope, fixture.original.scope);
    const receipts = await owner.query(`SELECT task_id FROM cm_delivery.register_write_receipts
      WHERE issue_key=$1 AND version=2`, [fixture.target.issueKey]);
    assert.equal(receipts.rows[0].task_id, '801-1');
  });

  await t.test('duplicate dispatch retains original provenance without another HTTP write', async () => {
    const fixture = await enroll(802);
    await invoke(fixture);
    const first = await provenance(fixture);
    fixture.state.deletedComment = true;
    assert.deepEqual(await invoke(fixture, { execution: { ...execution, runId: '101' } }), {
      result: 'JIRA_SCOPE_REVISION_ALREADY_CONFIRMED', writeSubmitted: false, readinessAuthorized: false,
    });
    assert.deepEqual(await provenance(fixture), first);
    assert.equal(fixture.state.puts.length, 1);
    assert.equal((await journal.prepareScopeRevision({ ...fixture.target,
      decision: fixture.proof, execution: { ...execution, runId: '102' } })).writeClaimed, undefined);
  });

  await t.test('the automatic append method and publisher cannot create a reclassification', async () => {
    const fixture = await enroll(803);
    const revised = deriveJiraScopeRevision(fixture.original, fixture.proof);
    await assert.rejects(journal.prepare({ ...fixture.target, scope: revised,
      expectedDigest: fixture.original.digest, claimWrite: true }), journalRejected);
    assert.deepEqual(await publishJiraRegister({ ...fixture.options, pool: operator }), {
      result: 'JIRA_REGISTER_UNCHANGED', writeSubmitted: false, readinessAuthorized: false,
    });
    assert.equal(await provenance(fixture), null);
    assert.equal(fixture.state.puts.length, 0);
  });

  await t.test('the unchanged append publisher preserves an explicitly confirmed supersession', async () => {
    const fixture = await enroll(804);
    await invoke(fixture);
    const approved = await provenance(fixture);
    fixture.state.newObligation = true;
    assert.equal((await publishJiraRegister({ ...fixture.options, pool: operator })).result, 'JIRA_REGISTER_CONFIRMED');
    const current = await journal.read(fixture.target);
    assert.equal(current.scope.version, 3);
    for (const entry of approved.scope.entries) {
      assert.deepEqual(current.scope.entries.find(value => value.repository === entry.repository && value.number === entry.number), entry);
    }
    assert.deepEqual(await provenance(fixture), approved, 'historical decision remains readable after later enrollment');
  });

  await t.test('an original queued revision is recovered after status change and comment deletion without resubmission', async () => {
    const fixture = await enroll(805); fixture.state.taskStatus = 'RUNNING';
    assert.equal((await invoke(fixture)).result, 'JIRA_SCOPE_REVISION_TASK_PENDING');
    const before = await provenance(fixture);
    fixture.state.issueStatus = 'Ready for Deployment';
    fixture.state.deletedComment = true;
    fixture.state.taskStatus = 'COMPLETE';
    const commentReads = fixture.state.commentReads;
    assert.deepEqual(await invoke(fixture), {
      result: 'JIRA_SCOPE_REVISION_CONFIRMED', writeSubmitted: false, readinessAuthorized: false,
    });
    const recovered = await provenance(fixture);
    assert.equal(recovered.digest, before.digest);
    assert.deepEqual(recovered.execution, before.execution);
    assert.equal(recovered.state, 'confirmed');
    assert.equal(fixture.state.puts.length, 1);
    assert.equal(fixture.state.commentReads, commentReads, 'recovery uses the immutable original decision');
  });

  await t.test('an uncertain provider submission stays quarantined even when its new property is visible', async () => {
    const fixture = await enroll(806); fixture.state.unknownWrite = true;
    await assert.rejects(invoke(fixture), rejected);
    const pending = await provenance(fixture);
    assert.equal(pending.state, 'pending');
    assert.equal(fixture.state.property.version, 2, 'provider might already have applied the write');
    assert.equal((await journal.readWriteReceipt({ ...fixture.target, digest: pending.digest })).taskId, null);
    fixture.state.unknownWrite = false;
    await assert.rejects(invoke(fixture), rejected);
    assert.equal(fixture.state.puts.length, 1);
    assert.deepEqual(await provenance(fixture), pending);
  });

  await t.test('existing unrelated pending claims are not observed, replaced or replayed', async () => {
    const fixture = await enroll(821);
    const pendingScope = { ...fixture.original.scope, version: 2, entries: [...fixture.original.scope.entries, reference(4)] };
    await journal.prepare({ ...fixture.target, scope: pendingScope, expectedDigest: fixture.original.digest, claimWrite: true });
    const pending = await journal.read(fixture.target);
    await assert.rejects(invoke(fixture), rejected);
    assert.deepEqual(await journal.read(fixture.target), pending);
    assert.equal(await provenance(fixture), null);
    assert.equal(fixture.state.puts.length, 0);
    assert.equal(fixture.state.gets.some(path => path.includes('/task/') || path.includes('/comment/')), false);
  });

  await t.test('a pending transition blocks a new revision while its original UUID and evidence remain unchanged', async () => {
    const fixture = await enroll(312);
    const transitions = createPostgresJiraTransitionJournal(owner);
    const claimed = await transitions.claim({ ...fixture.target, decision: { decisionKey: 'e'.repeat(64),
      registerVersion: 1, registerDigest: fixture.original.digest, actorId, transitionId: '4', sourceStatusId: '5',
      targetStatusId: '6', issueUpdatedAt: '2026-11-09T12:00:00.000Z' } });
    assert.equal(claimed.claimed, true);
    await assert.rejects(invoke(fixture), rejected);
    await assert.rejects(journal.prepareScopeRevision({ ...fixture.target, decision: fixture.proof, execution }), journalRejected);
    assert.deepEqual(await transitions.pending(fixture.target), claimed.attempt);
    assert.deepEqual(await journal.read(fixture.target), fixture.original);
    assert.equal(await provenance(fixture), null);
    assert.equal(fixture.state.puts.length, 0);
    assert.equal(fixture.state.gets.some(path => path.includes('/task/') || path.includes('/comment/')), false);
  });

  await t.test('an uncertain database COMMIT never grants a repeatable dispatch claim', async () => {
    const fixture = await enroll(820);
    let injected = false;
    const uncertainPool = { connect: async () => {
      const client = await operator.connect();
      let revisionInserted = false;
      return { on: client.on.bind(client), removeListener: client.removeListener.bind(client), release: client.release.bind(client),
        query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (sql.includes('INSERT INTO cm_delivery.register_scope_revisions')) revisionInserted = true;
          if (sql === 'COMMIT' && revisionInserted && !injected) {
            injected = true;
            throw new Error('private connection failure after a successful COMMIT');
          }
          return result;
        } };
    } };
    await assert.rejects(invoke(fixture, { pool: uncertainPool }), rejected);
    assert.equal(injected, true, 'failure reaches the committed revision, not an earlier precondition');
    const pending = await provenance(fixture);
    assert.equal(pending.state, 'pending');
    assert.equal((await journal.readWriteReceipt({ ...fixture.target, digest: pending.digest })).taskId, null);
    assert.equal(fixture.state.puts.length, 0);
    await assert.rejects(invoke(fixture), rejected);
    assert.equal(fixture.state.puts.length, 0);
    assert.deepEqual(await provenance(fixture), pending);
  });

  await t.test('a conditional property conflict cannot become a confirmed revision or another PUT', async () => {
    const fixture = await enroll(807); fixture.state.conflict = true;
    await assert.rejects(invoke(fixture), rejected);
    const pending = await provenance(fixture);
    assert.equal(pending.state, 'pending');
    assert.equal(fixture.state.property.version, 99);
    await assert.rejects(invoke(fixture), rejected);
    assert.equal(fixture.state.puts.length, 1);
    assert.deepEqual(await provenance(fixture), pending);
  });

  for (const [offset, name, modify] of [
    [0, 'new unregistered delivery obligation', fixture => { fixture.state.newObligation = true; }],
    [1, 'moving exact head', fixture => { fixture.state.headDrift = true; }],
    [2, 'edited decision during final collection', fixture => { fixture.state.commentDrift = true; }],
    [3, 'unauthorized token actor', fixture => { fixture.state.tokenActor = 'other-actor'; }],
    [4, 'unanchored Jira scope', fixture => { fixture.state.property.version = 2; }],
    [5, 'stale authorized decision', fixture => {
      const proof = makeDecision(fixture.original, { expectedRegisterDigest: 'f'.repeat(64) });
      fixture.state.comment = decisionComment(proof); fixture.options.expectedDecisionDigest = proof.decisionDigest;
    }],
  ]) {
    await t.test(`${name} cannot prepare or write a scope revision`, async () => {
      const fixture = await enroll(810 + offset); modify(fixture);
      await assert.rejects(invoke(fixture), rejected);
      assert.deepEqual(await journal.read(fixture.target), fixture.original);
      assert.equal(fixture.state.puts.length, 0);
      const count = await owner.query('SELECT count(*)::int AS count FROM cm_delivery.register_scope_revisions WHERE issue_key=$1',
        [fixture.target.issueKey]);
      assert.equal(count.rows[0].count, 0);
    });
  }

  await t.test('new revision intents require in Review but never perform a status transition', async () => {
    const fixture = await enroll(816); fixture.state.issueStatus = 'Ready for Deployment';
    assert.equal((await invoke(fixture)).result, 'JIRA_SCOPE_REVISION_ISSUE_NOT_IN_REVIEW');
    assert.deepEqual(await journal.read(fixture.target), fixture.original);
    assert.equal(fixture.state.puts.length, 0);
  });

  await t.test('the same physical issue lock excludes a second operator before provider access', async () => {
    const fixture = await enroll(817);
    await withJiraIssueLock({ pool: operator, ...fixture.target }, async () => {
      await assert.rejects(invoke(fixture), rejected);
      assert.equal(fixture.state.gets.length, 0);
      assert.equal(fixture.state.puts.length, 0);
    });
    assert.equal((await invoke(fixture)).result, 'JIRA_SCOPE_REVISION_CONFIRMED');
    assert.equal(fixture.state.puts.length, 1);
  });

  await t.test('provenance failure rolls back the new journal and claim in the same transaction', async () => {
    const fixture = await enroll(818);
    await owner.query('REVOKE INSERT ON cm_delivery.register_scope_revisions FROM cm_scope_revision_writer_test');
    try {
      await assert.rejects(invoke(fixture), rejected);
      assert.deepEqual(await journal.read(fixture.target), fixture.original);
      assert.equal(await provenance(fixture), null);
      assert.equal(fixture.state.puts.length, 0);
      const count = await owner.query('SELECT count(*)::int AS count FROM cm_delivery.register_write_receipts WHERE issue_key=$1',
        [fixture.target.issueKey]);
      assert.equal(count.rows[0].count, 0);
    } finally {
      await owner.query('GRANT INSERT ON cm_delivery.register_scope_revisions TO cm_scope_revision_writer_test');
    }
  });

  await t.test('the actual operator role cannot edit or delete history, grant authority or rewrite a scope', async () => {
    const fixture = await enroll(819); await invoke(fixture);
    const approved = await provenance(fixture);
    for (const sql of [
      'UPDATE cm_delivery.register_scope_revisions SET actor_id=$1 WHERE issue_key=$2',
      'DELETE FROM cm_delivery.register_scope_revisions WHERE actor_id=$1 AND issue_key=$2',
      'UPDATE cm_delivery.register_journal SET digest=$1 WHERE issue_key=$2',
    ]) {
      await assert.rejects(operator.query(sql, ['f'.repeat(64), fixture.target.issueKey]), error => error.code === '42501');
    }
    await assert.rejects(operator.query('CREATE TABLE cm_delivery.unapproved_scope (id integer)'), error => error.code === '42501');
    assert.deepEqual(await provenance(fixture), approved);
    assert.equal(canonicalJiraRegister(fixture.state.property).digest, approved.digest);
  });
});
