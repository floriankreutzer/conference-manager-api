import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateJiraPrReadiness } from '../scripts/jira-pr-readiness.mjs';

const now = 1800000000000;
const sha = 'a'.repeat(40);
const repositories = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];

function fixture() {
  const pullRequests = repositories.map((repository, index) => ({
    repository, number: index + 1, issueKey: 'CO-296', draft: false, state: 'closed', merged: true,
    mergedAt: now - 20000, headSha: sha, mergeSha: 'b'.repeat(40), checksHeadSha: sha,
    requiredChecks: [{ name: 'quality', appId: 15368 }], checksComplete: true,
    checks: [{ name: 'quality', appId: 15368, headSha: sha, status: 'completed', conclusion: 'success' }],
    policyComplete: true, policyRevision: sha, reviewsComplete: true, reviewHeadSha: sha,
    unresolvedThreads: 0, unresolvedFindings: 0, reviewCompleted: true, changesRequested: false,
    requiredApprovals: 0, validApprovals: 0,
  }));
  return {
    schemaVersion: 1, issueKey: 'CO-296', issueStatus: 'in Review', startedAt: now - 10000, collectedAt: now,
    scopeRevision: sha, scopeClosed: true, associationComplete: true, indexConsistent: true,
    inventories: repositories.map((repository) => ({
      repository, authenticated: true, complete: true, nextPage: null, incompleteResults: false, count: 1, returnedCount: 1,
    })),
    expectedPullRequests: pullRequests.map(({ repository, number }) => ({ repository, number })), pullRequests,
  };
}

test('all merged with exact fresh scope and gates yields a bounded readiness decision, never Done', () => {
  const result = evaluateJiraPrReadiness(fixture(), { now });
  assert.equal(result.eligible, true);
  assert.equal(result.targetStatus, 'Ready for Deployment');
  assert.match(result.decisionKey, /^[a-f0-9]{64}$/);
});

const mutations = {
  draft: (s) => { s.pullRequests[0].draft = true; },
  'unknown draft': (s) => { delete s.pullRequests[0].draft; },
  'partial merge': (s) => { s.pullRequests[1].merged = false; s.pullRequests[1].state = 'open'; },
  'closed unmerged': (s) => { s.pullRequests[0].merged = false; },
  'no PR': (s) => { s.expectedPullRequests = []; s.pullRequests = []; },
  'missing PR': (s) => { s.pullRequests.pop(); },
  'unexpected PR': (s) => { s.pullRequests.push({ ...s.pullRequests[0], number: 500 }); },
  'duplicate PR': (s) => { s.pullRequests.push(s.pullRequests[0]); },
  'foreign repository': (s) => { s.pullRequests[0].repository = 'other/private'; },
  'wrong issue': (s) => { s.pullRequests[0].issueKey = 'CO-29'; },
  'index incomplete': (s) => { s.indexConsistent = false; },
  'scope not closed': (s) => { s.scopeClosed = false; },
  'association unknown': (s) => { s.associationComplete = null; },
  'missing repository inventory': (s) => { s.inventories.pop(); },
  'pagination unfinished': (s) => { s.inventories[0].nextPage = 2; },
  'truncated inventory': (s) => { s.inventories[0].count = 2; },
  'anonymous inventory': (s) => { s.inventories[0].authenticated = false; },
  'inventory undercounts PRs': (s) => { s.inventories[0].count = 0; s.inventories[0].returnedCount = 0; },
  'sparse PR set': (s) => { delete s.pullRequests[0]; },
  'sparse expected set': (s) => { delete s.expectedPullRequests[0]; },
  'coerced SHA': (s) => { s.scopeRevision = [sha]; },
  'stale observation': (s) => { s.startedAt = now - 60001; },
  'future observation': (s) => { s.collectedAt = now + 1; },
  'failed check': (s) => { s.pullRequests[0].checks[0].conclusion = 'failure'; },
  'skipped check': (s) => { s.pullRequests[0].checks[0].conclusion = 'skipped'; },
  'pending check': (s) => { s.pullRequests[0].checks[0].status = 'in_progress'; },
  'wrong check producer': (s) => { s.pullRequests[0].checks[0].appId = 999; },
  'old head check': (s) => { s.pullRequests[0].checks[0].headSha = 'c'.repeat(40); },
  'ambiguous check attempts': (s) => { s.pullRequests[0].checks.push(s.pullRequests[0].checks[0]); },
  'missing required checks': (s) => { s.pullRequests[0].requiredChecks = []; },
  'unknown policy': (s) => { s.pullRequests[0].policyComplete = false; },
  'missing review': (s) => { s.pullRequests[0].reviewCompleted = false; },
  'old head review': (s) => { s.pullRequests[0].reviewHeadSha = 'c'.repeat(40); },
  'unresolved finding': (s) => { s.pullRequests[0].unresolvedFindings = 1; },
  'unresolved thread': (s) => { s.pullRequests[0].unresolvedThreads = 1; },
  'required approval absent': (s) => { s.pullRequests[0].requiredApprovals = 1; },
  'already promoted': (s) => { s.issueStatus = 'Ready for Deployment'; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`blocks ${name}`, () => {
    const snapshot = fixture();
    mutate(snapshot);
    assert.equal(evaluateJiraPrReadiness(snapshot, { now }).eligible, false);
  });
}

test('stable decision key supports deduplication independently of observation time and PR order', () => {
  const first = fixture();
  const second = fixture();
  second.startedAt += 1;
  second.pullRequests.reverse();
  assert.equal(evaluateJiraPrReadiness(first, { now }).decisionKey, evaluateJiraPrReadiness(second, { now }).decisionKey);
  second.scopeRevision = 'd'.repeat(40);
  assert.notEqual(evaluateJiraPrReadiness(first, { now }).decisionKey, evaluateJiraPrReadiness(second, { now }).decisionKey);
});

test('Product Acceptance does not grant Done or override missing technical gates', () => {
  for (const productAcceptance of ['Pending', 'Rejected', 'Accepted', 'Not required']) {
    const snapshot = { ...fixture(), productAcceptance };
    assert.equal(evaluateJiraPrReadiness(snapshot, { now }).targetStatus, 'Ready for Deployment');
    snapshot.pullRequests[0].merged = false;
    assert.equal(evaluateJiraPrReadiness(snapshot, { now }).eligible, false);
  }
});

test('malformed top-level values do not produce readiness', () => {
  for (const value of [null, undefined, [], {}, 'approved', { ...fixture(), issueKey: 'CO-296/../../' }]) {
    assert.equal(evaluateJiraPrReadiness(value, { now }).eligible, false);
  }
});
