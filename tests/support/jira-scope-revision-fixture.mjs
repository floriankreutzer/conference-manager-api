import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJiraRegister } from '../../scripts/jira-register-journal.mjs';
import { JIRA_REGISTER_PROPERTY } from '../../scripts/jira-register-reader.mjs';

export const repositories = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
export const actorId = 'test-qualified-writer';
export const execution = { sourceSha: 'd'.repeat(40), runId: '100', runAttempt: 1, githubActorId: '123' };
export const binding = { cloudId: '11111111-1111-1111-1111-111111111111', issueKey: 'CO-296', issueId: '10296' };
export const reference = (number, repository = repositories[0]) => ({ repository, number, kind: 'delivery' });
export const initialScope = (issueKey = binding.issueKey) => ({ schemaVersion: 1, issueKey, version: 1,
  closed: true, entries: [reference(1), reference(2, repositories[1])] });
export const checkpoint = scope => ({ ...canonicalJiraRegister(scope), state: 'confirmed' });

export function makeDecision(current = checkpoint(initialScope()), overrides = {}) {
  const value = { schemaVersion: 1, operation: 'supersede', issueKey: current.scope.issueKey,
    expectedRegisterVersion: current.scope.version, expectedRegisterDigest: current.digest,
    supersessions: [{ repository: repositories[0], number: 1, headSha: 'a'.repeat(40),
      replacedBy: { repository: repositories[0], number: 3, headSha: 'c'.repeat(40) },
      reason: 'Explicit owner decision: the replacement preserves the original source and its reviewed correction.' }], ...overrides };
  const decisionText = JSON.stringify(value, null, 2);
  return { commentId: '10001', actorId, createdAt: '2026-11-09T12:00:00.000Z', decisionText,
    decisionDigest: createHash('sha256').update(decisionText).digest('hex') };
}

export function decisionComment(proof = makeDecision()) {
  return { id: proof.commentId, author: { accountId: actorId, active: true },
    updateAuthor: { accountId: actorId, active: true }, created: proof.createdAt, updated: proof.createdAt,
    body: { version: 1, type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'json' },
      content: [{ type: 'text', text: proof.decisionText }] }] } };
}

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

/** Routed protocol fixture only; PostgreSQL is supplied separately by integration tests. */
export function scopeRevisionProvider(issueNumber = 296) {
  const target = { ...binding, issueKey: `CO-${issueNumber}`, issueId: String(10000 + issueNumber) };
  const original = checkpoint(initialScope(target.issueKey));
  const proof = makeDecision(original);
  const state = { property: structuredClone(original.scope), comment: decisionComment(proof), puts: [], gets: [],
    tasks: new Map(), taskStatus: 'COMPLETE', issueStatus: 'in Review', inventoryReads: 0, commentReads: 0 };
  const config = { ...target, actorId, email: 'test@example.invalid', token: 'test-only-jira-token',
    githubToken: 'test-only-github-token', commentId: proof.commentId,
    expectedDecisionDigest: proof.decisionDigest, execution };
  const fetchImpl = async (raw, request) => {
    const url = new URL(raw);
    assert.ok(['error', 'manual'].includes(request.redirect));
    if (url.origin === 'https://api.github.com') {
      assert.equal(request.method, 'GET');
      state.inventoryReads++;
      const repository = repositories.find(repo => url.pathname === `/repos/${repo}/pulls`);
      assert.ok(repository);
      const pr = (number, sha, title) => ({ number, title, draft: false, state: 'closed',
        base: { repo: { full_name: repository } }, head: { sha, ref: `delivery-${number}` } });
      const changedHead = state.headDrift && state.inventoryReads > 4;
      const rows = repository === repositories[0]
        ? [pr(1, changedHead ? 'f'.repeat(40) : 'a'.repeat(40), `${target.issueKey} original`),
          pr(3, 'c'.repeat(40), 'CO-320 integrated replacement')]
        : [pr(2, 'b'.repeat(40), `${target.issueKey} API obligation`)];
      if (state.newObligation) rows.push(pr(4, 'e'.repeat(40), `${target.issueKey} newly discovered work`));
      return json(url.searchParams.get('page') === '1' ? rows : []);
    }
    assert.equal(url.origin, 'https://api.atlassian.com');
    const base = `/ex/jira/${target.cloudId}/rest/api/3`;
    assert.ok(url.pathname.startsWith(base));
    if (request.method === 'PUT') {
      const body = JSON.parse(request.body);
      state.puts.push(body);
      assert.deepEqual(body.filter.entityIds, [Number(target.issueId)]);
      assert.equal(body.filter.hasProperty, true);
      if (state.conflict) state.property = { ...state.property, version: 99 };
      const eligible = JSON.stringify(body.filter.currentValue) === JSON.stringify(state.property);
      const id = `${issueNumber}-${state.puts.length}`;
      let applied = false;
      const apply = () => {
        if (eligible && !applied) state.property = body.value;
        applied = true;
      };
      state.tasks.set(id, apply);
      if (state.taskStatus === 'COMPLETE') apply();
      if (state.unknownWrite) throw new Error('private provider failure after submission');
      return new Response(null, { status: 303, headers: { location: `https://fixture.invalid/rest/api/3/task/${id}` } });
    }
    assert.equal(request.method, 'GET');
    state.gets.push(url.pathname);
    if (url.pathname === `${base}/myself`) return json({ accountId: state.tokenActor ?? actorId, active: true });
    if (url.pathname === `${base}/issue/${target.issueKey}/comment/${proof.commentId}`) {
      state.commentReads++;
      if (state.deletedComment) return new Response(null, { status: 404 });
      if (state.commentDrift && state.commentReads > 1) {
        return json({ ...state.comment, updated: '2026-11-09T12:01:00.000Z' });
      }
      return json(state.comment);
    }
    if (url.pathname.startsWith(`${base}/task/`)) {
      const id = url.pathname.split('/').at(-1);
      assert.ok(state.tasks.has(id));
      if (state.taskStatus === 'COMPLETE') state.tasks.get(id)();
      return json({ id, status: state.taskStatus });
    }
    if (url.pathname.endsWith(`/properties/${JIRA_REGISTER_PROPERTY}`)) {
      return state.property === null ? new Response(null, { status: 404 })
        : json({ key: JIRA_REGISTER_PROPERTY, value: state.property });
    }
    assert.equal(url.pathname, `${base}/issue/${target.issueKey}`);
    return json({ id: target.issueId, key: target.issueKey, fields: { project: { key: 'CO' },
      status: { name: state.issueStatus }, updated: '2026-11-09T12:00:00.000Z' } });
  };
  return { target, original, proof, state, options: { ...config, fetchImpl } };
}
