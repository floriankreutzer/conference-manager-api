import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGithubPrGates } from '../scripts/jira-github-gates.mjs';
import { evaluateJiraPrReadiness } from '../scripts/jira-pr-readiness.mjs';
import { runGatesDiagnostic } from '../scripts/jira-gates-diagnostic.mjs';

const repository = 'floriankreutzer/conference-manager-api';
const token = 'test-only-credential';
const sha = 'a'.repeat(40);
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function fixture() {
  return {
    branch: { name: 'main', protected: true, protection: { enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } },
    pr: { number: 1, base: { ref: 'main', repo: { full_name: repository } }, head: { sha }, draft: false,
      state: 'closed', merged: true, merge_commit_sha: 'b'.repeat(40), merged_at: '2026-01-01T00:00:00Z', user: { id: 7 } },
    rules: [{ ruleset_id: 1, type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: false,
      require_last_push_approval: false, required_review_thread_resolution: true } },
    { ruleset_id: 1, type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'quality', integration_id: 15368 }] } }],
    runs: [{ id: 2, head_sha: sha, app: { id: 15368 }, name: 'quality', status: 'completed', conclusion: 'success' }],
    reviews: [],
    comments: [{ id: 3, user: { id: 199175422, type: 'Bot', login: 'chatgpt-codex-connector[bot]' },
      body: '<!-- codex-review-state:v1 ' + JSON.stringify({ code_review: { commit_sha: sha,
        status: 'completed', has_any_findings: false, has_unresolved_findings: false } }) + ' -->' }],
    threads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}
function transport(f, mutate = () => {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    mutate(f, url, calls);
    if (url.endsWith('/graphql')) {
      assert.equal(options.method, 'POST');
      assert.ok(JSON.parse(options.body).query.startsWith('query('));
      return response({ data: { repository: { nameWithOwner: repository, pullRequest: {
        number: 1, headRefOid: sha, reviewThreads: f.threads } } } });
    }
    assert.equal(options.method, 'GET');
    if (url.endsWith('/pulls/1')) return response(f.pr);
    if (url.includes('/rules/branches/main?')) return response(url.endsWith('page=1') ? f.rules : []);
    if (url.endsWith('/branches/main')) return response(f.branch);
    const first = url.endsWith('page=1');
    if (url.includes('/check-runs?')) return response({ total_count: f.runs.length, check_runs: first ? f.runs : [] });
    if (url.includes('/reviews?')) return response(first ? f.reviews : []);
    if (url.includes('/comments?')) return response(first ? f.comments : []);
    assert.fail('unexpected URL');
  } };
}
const collect = (f, mutate) => collectGithubPrGates({ token, repository, number: 1, ...transport(f, mutate) });

test('real transport composition produces head- and producer-bound kernel evidence without mutation', async () => {
  const f = fixture();
  const t = transport(f);
  const evidence = await collectGithubPrGates({ token, repository, number: 1, ...t });
  const now = Date.now();
  const inventories = ['floriankreutzer/conference-manager', repository].map((repo) => ({ repository: repo,
    authenticated: true, complete: true, nextPage: null, incompleteResults: false, count: 1, returnedCount: 1 }));
  const decision = evaluateJiraPrReadiness({ schemaVersion: 1, issueKey: 'CO-296', issueStatus: 'in Review',
    startedAt: evidence.startedAt, collectedAt: now, scopeRevision: 'c'.repeat(40), scopeClosed: true,
    associationComplete: true, indexConsistent: true, inventories,
    expectedPullRequests: [{ repository, number: 1 }], pullRequests: [{ ...evidence, issueKey: 'CO-296' }] });
  assert.equal(decision.eligible, true);
  assert.equal(evidence.validApprovals, 0);
  assert.equal(evidence.reviewCompleted, true);
  assert.equal(JSON.stringify(evidence).includes(token), false);
  assert.equal(t.calls.filter(({ url }) => url.endsWith('/pulls/1')).length, 2);
  assert.equal(t.calls.filter(({ url }) => url.includes('/rules/branches/main?')).length, 4);
});

for (const state of ['queued', 'in_progress', 'completed']) {
  test(`newest ${state} check attempt cannot inherit older success`, async () => {
    const f = fixture();
    f.runs.push({ ...f.runs[0], id: 4, status: state, conclusion: state === 'completed' ? 'failure' : null });
    const result = await collect(f);
    assert.equal(result.checks[0].status, state);
    assert.notEqual(result.checks[0].conclusion, 'success');
  });
}

for (const [name, mutate] of Object.entries({
  'wrong check producer': (f) => { f.runs[0].app.id = 9; },
  'classic branch protection active': (f) => { f.branch.protection.enabled = true; },
  'classic branch protection unknown': (f) => { delete f.branch.protection; },
  'foreign check head': (f) => { f.runs[0].head_sha = 'f'.repeat(40); },
  'spoofed summary': (f) => { f.comments[0].user.id = 7; },
  'old review head': (f) => { f.comments[0].body = f.comments[0].body.replace(sha, 'f'.repeat(40)); },
  'duplicate summaries': (f) => { f.comments.push({ ...f.comments[0], id: 8 }); },
  'duplicate check IDs': (f) => { f.runs.push({ ...f.runs[0] }); },
  'unknown policy': (f) => { f.rules.push({ type: 'required_deployments' }); },
  'missing producer binding': (f) => { delete f.rules[1].parameters.required_status_checks[0].integration_id; },
  'no review policy': (f) => { f.rules.shift(); },
  'nonzero approval policy': (f) => { f.rules[0].parameters.required_approving_review_count = 1; },
  'code owner policy': (f) => { f.rules[0].parameters.require_code_owner_review = true; },
  'foreign base': (f) => { f.pr.base.repo.full_name = 'other/repo'; },
  'non-main base': (f) => { f.pr.base.ref = 'other'; },
  'unknown thread status': (f) => { f.threads.nodes = [{ id: 'x' }]; },
  'duplicate threads': (f) => { f.threads.nodes = [{ id: 'x', isResolved: true }, { id: 'x', isResolved: true }]; },
})) {
  test(`fails closed for ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(collect(f), { message: 'GITHUB_PR_GATES_UNVERIFIED' });
  });
}

test('final recollection detects moved PR head', async () => {
  await assert.rejects(collect(fixture(), (f, url, calls) => {
    if (url.endsWith('/pulls/1') && calls.filter((c) => c.url === url).length === 2) f.pr.head.sha = 'f'.repeat(40);
  }), { message: 'GITHUB_PR_GATES_UNVERIFIED' });
});
test('final recollection detects policy change', async () => {
  await assert.rejects(collect(fixture(), (f, url, calls) => {
    if (url.includes('/rules/branches/main?') && calls.filter((c) => c.url === url).length === 2) f.rules.pop();
  }), { message: 'GITHUB_PR_GATES_UNVERIFIED' });
});
test('unresolved findings, threads and requested changes remain blocking evidence', async () => {
  const f = fixture();
  f.comments[0].body = f.comments[0].body.replace('"has_unresolved_findings":false', '"has_unresolved_findings":true');
  f.threads.nodes = [{ id: 'thread', isResolved: false }];
  f.reviews = [{ id: 1, user: { id: 9 }, commit_id: sha, state: 'CHANGES_REQUESTED' }];
  const result = await collect(f);
  assert.equal(result.unresolvedFindings, 1);
  assert.equal(result.unresolvedThreads, 1);
  assert.equal(result.changesRequested, true);
});
test('open drafts remain unmerged rather than being filtered out', async () => {
  const f = fixture();
  Object.assign(f.pr, { draft: true, state: 'open', merged: false, merged_at: null, merge_commit_sha: null });
  const result = await collect(f);
  assert.equal(result.draft, true);
  assert.equal(result.merged, false);
});
for (const status of [301, 401, 403, 429, 500]) {
  test(`redacts HTTP ${status} failures`, async () => {
    await assert.rejects(collectGithubPrGates({ token, repository, number: 1,
      fetchImpl: async () => new Response(token, { status }) }), { message: 'GITHUB_PR_GATES_UNVERIFIED' });
  });
}
test('invalid scope and credential never reach transport', async () => {
  for (const input of [{ repository: 'other/repo' }, { token: '' }, { number: -1 }]) {
    await assert.rejects(collectGithubPrGates({ token, repository, number: 1, ...input,
      fetchImpl: () => assert.fail('called') }), { message: 'GITHUB_PR_GATES_UNVERIFIED' });
  }
});

test('diagnostic emits bounded results without token, refs or review payload', async () => {
  const lines = [];
  const result = await runGatesDiagnostic({ token, repository, number: 1, ...transport(fixture()), write: (line) => lines.push(line) });
  assert.equal(result, 0);
  const report = JSON.parse(lines[0]);
  assert.equal(report.readinessEvaluated, false);
  assert.equal(report.mutationPerformed, false);
  for (const privateValue of [sha, token, 'codex-review-state', repository]) assert.equal(lines[0].includes(privateValue), false);
});
test('diagnostic reports transport failure without emitting its error', async () => {
  const lines = [];
  assert.equal(await runGatesDiagnostic({ token, repository, number: 1,
    fetchImpl: () => { throw new Error(token); }, write: (line) => lines.push(line) }), 1);
  assert.equal(lines[0].includes(token), false);
  assert.equal(JSON.parse(lines[0]).result, 'GITHUB_PR_GATES_UNVERIFIED');
});
test('rejects missing check totals and incomplete check enumeration', async () => {
  for (const value of [{ check_runs: [] }, { total_count: 1, check_runs: [] }]) {
    const base = transport(fixture()).fetchImpl;
    await assert.rejects(collectGithubPrGates({ token, repository, number: 1,
      fetchImpl: (url, options) => url.includes('/check-runs?') ? response(value) : base(url, options) }),
    { message: 'GITHUB_PR_GATES_UNVERIFIED' });
  }
});
test('reads a second check page and keeps later failure', async () => {
  const f = fixture();
  const base = transport(f).fetchImpl;
  const result = await collectGithubPrGates({ token, repository, number: 1, fetchImpl: (url, options) => {
    if (!url.includes('/check-runs?')) return base(url, options);
    const page = Number(new URL(url).searchParams.get('page'));
    const run = { ...f.runs[0], id: page, conclusion: page === 2 ? 'failure' : 'success' };
    return response({ total_count: 2, check_runs: page <= 2 ? [run] : [] });
  } });
  assert.equal(result.checks[0].conclusion, 'failure');
});
test('GraphQL partial errors cannot certify resolved threads', async () => {
  const base = transport(fixture()).fetchImpl;
  await assert.rejects(collectGithubPrGates({ token, repository, number: 1,
    fetchImpl: (url, options) => url.endsWith('/graphql') ? response({ errors: [{ message: token }] }) : base(url, options) }),
  { message: 'GITHUB_PR_GATES_UNVERIFIED' });
});
test('reads all thread pages and rejects repeated cursors', async () => {
  for (const repeat of [false, true]) {
    const f = fixture();
    let page = 0;
    const work = collect(f, (state, url) => {
      if (!url.endsWith('/graphql')) return;
      page++;
      state.threads = { nodes: [{ id: `thread-${page}`, isResolved: false }],
        pageInfo: { hasNextPage: repeat || page === 1, endCursor: 'cursor-1' } };
    });
    if (repeat) await assert.rejects(work, { message: 'GITHUB_PR_GATES_UNVERIFIED' });
    else assert.equal((await work).unresolvedThreads, 2);
  }
});
test('rejects oversized responses and reflected transport errors', async () => {
  for (const fetchImpl of [async () => response('x'.repeat(4 * 1024 * 1024)), async () => { throw new Error(token); }]) {
    await assert.rejects(collectGithubPrGates({ token, repository, number: 1, fetchImpl }),
      { message: 'GITHUB_PR_GATES_UNVERIFIED' });
  }
});
