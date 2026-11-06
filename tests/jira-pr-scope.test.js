import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileJiraPrScope } from '../scripts/jira-pr-scope.mjs';

function fixture() {
  const delivery = { repository: 'floriankreutzer/conference-manager-api', number: 378, kind: 'delivery' };
  const supporting = { repository: 'example/knowledge', number: 61, kind: 'supporting', reason: 'Knowledge only' };
  return { scope: { schemaVersion: 1, issueKey: 'CO-296', version: 1, closed: true, entries: [delivery, supporting] },
    association: { issueKey: 'CO-296', complete: true, stale: false, pullRequests: [delivery, supporting] } };
}

test('explicit supporting PR stays in reconciliation but not delivery', () => {
  const { scope, association } = fixture();
  const result = reconcileJiraPrScope(scope, association);
  assert.equal(result.complete, true);
  assert.deepEqual(result.expectedPullRequests, [{ repository: 'floriankreutzer/conference-manager-api', number: 378 }]);
  scope.entries.reverse();
  assert.equal(reconcileJiraPrScope(scope, association).scopeRevision, result.scopeRevision);
  scope.version++;
  assert.notEqual(reconcileJiraPrScope(scope, association).scopeRevision, result.scopeRevision);
});

for (const [name, mutate] of [
  ['unclosed', (s) => { s.closed = false; }],
  ['missing explanation', (s) => { s.entries[1].reason = ''; }],
  ['foreign delivery', (s) => { s.entries[1].kind = 'delivery'; }],
  ['unresolved supersession', (s) => { s.entries[1].kind = 'superseded'; }],
  ['duplicate scope', (s) => { s.entries.push(s.entries[0]); }],
  ['unknown linked PR', (_, a) => { a.pullRequests.push({ repository: 'example/other', number: 1 }); }],
  ['missing linked PR', (_, a) => { a.pullRequests.pop(); }],
  ['duplicate association', (_, a) => { a.pullRequests.push(a.pullRequests[0]); }],
  ['stale index', (_, a) => { a.stale = true; }],
  ['partial index', (_, a) => { a.complete = false; }],
  ['wrong issue', (_, a) => { a.issueKey = 'CO-297'; }],
  ['empty scope', (s, a) => { s.entries = []; a.pullRequests = []; }],
  ['sparse list', (s) => { delete s.entries[1]; }],
]) {
  test(`blocks ${name}`, () => {
    const { scope, association } = fixture();
    mutate(scope, association);
    assert.equal(reconcileJiraPrScope(scope, association).complete, false);
  });
}

test('supersession must point directly to included delivery PR', () => {
  const { scope, association } = fixture();
  scope.entries[1].kind = 'superseded';
  scope.entries[1].replacedBy = scope.entries[0];
  assert.equal(reconcileJiraPrScope(scope, association).complete, true);
  scope.entries[1].replacedBy = scope.entries[1];
  assert.equal(reconcileJiraPrScope(scope, association).complete, false);
});
