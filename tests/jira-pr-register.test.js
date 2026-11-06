import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeJiraPrRegister } from '../scripts/jira-pr-register.mjs';

const repositories = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
function fixture() {
  return { issueKey: 'CO-296', now: 100,
    inventory: { startedAt: 0, collectedAt: 100,
      inventories: repositories.map((repository) => ({ repository, authenticated: true, complete: true,
        nextPage: null, incompleteResults: false, count: 1, returnedCount: 1 })),
      pullRequests: repositories.map((repository, i) => ({ repository, number: i + 1,
        title: i ? 'Other change' : 'CO-296 Delivery', headRef: i ? 'CO-296-api' : 'branch' })) } };
}
test('registers both repositories and preserves stable revision on duplicate collection', () => {
  const input = fixture();
  const first = proposeJiraPrRegister(input);
  assert.equal(first.changed, true);
  assert.equal(first.scope.version, 1);
  assert.equal(first.expectedPullRequests.length, 2);
  const repeat = proposeJiraPrRegister({ ...input, previous: first.scope });
  assert.equal(repeat.changed, false);
  assert.equal(repeat.scopeRevision, first.scopeRevision);
});
test('renaming title and branch cannot remove an existing delivery obligation', () => {
  const input = fixture();
  const previous = proposeJiraPrRegister(input).scope;
  for (const pr of input.inventory.pullRequests) { pr.title = 'Renamed'; pr.headRef = 'renamed'; }
  assert.deepEqual(proposeJiraPrRegister({ ...input, previous }).scope, previous);
});
test('new linked PR increments version and remains delivery regardless of state', () => {
  const input = fixture();
  const previous = proposeJiraPrRegister(input).scope;
  input.inventory.pullRequests.push({ ...input.inventory.pullRequests[0], number: 3, draft: true, state: 'closed' });
  input.inventory.inventories[0].count++;
  input.inventory.inventories[0].returnedCount++;
  const next = proposeJiraPrRegister({ ...input, previous });
  assert.equal(next.scope.version, 2);
  assert.equal(next.expectedPullRequests.length, 3);
  assert.equal(previous.entries.length, 2);
});
test('does not match a longer issue number or embedded alphanumeric key', () => {
  const input = fixture();
  input.inventory.pullRequests[0].title = 'CO-2960 and XCO-296';
  assert.equal(proposeJiraPrRegister(input).expectedPullRequests.length, 1);
});
test('retains explicit supporting classification without mutating input', () => {
  const input = fixture();
  const previous = proposeJiraPrRegister(input).scope;
  previous.entries.push({ repository: 'example/knowledge', number: 1, kind: 'supporting', reason: 'Documentation' });
  const before = structuredClone(previous);
  assert.equal(proposeJiraPrRegister({ ...input, previous }).expectedPullRequests.length, 2);
  assert.deepEqual(previous, before);
});
for (const [name, mutate] of [
  ['stale collection', (x) => { x.now = 60001; }],
  ['future collection', (x) => { x.now = 99; }],
  ['partial inventory', (x) => { x.inventory.inventories[0].complete = false; }],
  ['unauthenticated inventory', (x) => { x.inventory.inventories[0].authenticated = false; }],
  ['pending page', (x) => { x.inventory.inventories[0].nextPage = 2; }],
  ['inconsistent count', (x) => { x.inventory.inventories[0].count = 2; }],
  ['duplicate repository', (x) => { x.inventory.inventories[1] = x.inventory.inventories[0]; }],
  ['duplicate PR', (x) => { x.inventory.pullRequests[1] = x.inventory.pullRequests[0]; }],
  ['sparse inventory', (x) => { delete x.inventory.pullRequests[0]; }],
  ['foreign repository', (x) => { x.inventory.pullRequests[0].repository = 'example/foreign'; }],
  ['wrong previous issue', (x) => { x.previous.issueKey = 'CO-297'; }],
  ['invalid previous exception', (x) => { x.previous.entries[0].kind = 'superseded'; }],
  ['version overflow', (x) => { x.previous.version = Number.MAX_SAFE_INTEGER; x.previous.entries.pop(); }],
  ['missing historical PR', (x) => { x.inventory.pullRequests[0].number = 99; }],
]) {
  test(`blocks ${name}`, () => {
    const input = fixture();
    input.previous = proposeJiraPrRegister(input).scope;
    mutate(input);
    assert.throws(() => proposeJiraPrRegister(input), { message: 'JIRA_PR_REGISTER_UNVERIFIED' });
  });
}
test('empty automatic association never closes scope', () => {
  const input = fixture();
  input.issueKey = 'CO-999';
  assert.throws(() => proposeJiraPrRegister(input), { message: 'JIRA_PR_REGISTER_UNVERIFIED' });
});
