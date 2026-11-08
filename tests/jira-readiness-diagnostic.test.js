import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { diagnoseJiraReadiness, runReadinessDiagnostic } from '../scripts/jira-readiness-diagnostic.mjs';

import { fixture, transport, options, response } from './support/jira-readiness-fixture.mjs';

const diagnose = (f, mutate) => diagnoseJiraReadiness({ ...options, ...transport(f, mutate) });
const fail = { message: 'JIRA_READINESS_DIAGNOSTIC_UNVERIFIED' };

test('composes actual read adapters twice and never authorizes a transition', async () => {
  const t = transport(fixture());
  const result = await diagnoseJiraReadiness({ ...options, ...t });
  assert.equal(result.candidateGateResult, 'CANDIDATE_GATES_PASS');
  assert.equal(result.deliveryPullRequests, 2);
  assert.equal(result.enrollmentRequired, false);
  assert.equal(result.registerUpdateRequired, false);
  assert.equal(result.registerProvenanceVerified, false);
  assert.equal(result.readinessAuthorized, false);
  assert.equal(result.mutationPerformed, false);
  assert.equal('decisionKey' in result, false);
  assert.equal('targetStatus' in result, false);
  assert.equal(t.calls.filter((c) => c.url.endsWith('/pulls/1')).length, 4);
  assert.equal(t.calls.filter((c) => c.url.includes('fields=project')).length, 2);
  assert.equal(t.calls.filter((c) => c.url.includes('/pulls?') && c.url.endsWith('page=1')).length, 4);
});

test('missing register discovers obligations but remains unenrolled and unauthorized', async () => {
  const f = fixture();
  f.scope = null;
  const result = await diagnose(f);
  assert.equal(result.enrollmentRequired, true);
  assert.equal(result.registerUpdateRequired, true);
  assert.equal(result.deliveryPullRequests, 2);
  assert.equal(result.readinessAuthorized, false);
});
test('a newly discovered draft omitted by the stored register remains blocking', async () => {
  const f = fixture();
  f.scope.entries.pop();
  Object.assign(f.prs[1], { draft: true, state: 'open', merged: false, merged_at: null, merge_commit_sha: null });
  const result = await diagnose(f);
  assert.equal(result.registerUpdateRequired, true);
  assert.equal(result.deliveryPullRequests, 2);
  assert.equal(result.candidateGateResult, 'UNMERGED_OR_UNKNOWN_PR');
});
test('renaming a registered PR never removes its obligation', async () => {
  const f = fixture();
  f.prs[1].title = 'Unrelated title';
  f.prs[1].head.ref = 'renamed';
  f.prs[1].merged = false;
  assert.equal((await diagnose(f)).candidateGateResult, 'UNMERGED_OR_UNKNOWN_PR');
});
test('supporting classifications are retained without pretending writer authorization', async () => {
  const f = fixture();
  f.scope.entries.push({ repository: 'example/notes', number: 5, kind: 'supporting', reason: 'Documentation only' });
  const result = await diagnose(f);
  assert.equal(result.deliveryPullRequests, 2);
  assert.equal(result.registerProvenanceVerified, false);
});
test('absent association cannot become a successful empty set', async () => {
  const f = fixture();
  f.scope = null;
  f.prs = [];
  await assert.rejects(diagnose(f), fail);
});

for (const [name, change, reason] of [
  ['closed unmerged', (f) => { f.prs[1].merged = false; }, 'UNMERGED_OR_UNKNOWN_PR'],
  ['pending check', (f) => { f.checkStatus = 'queued'; f.checkConclusion = null; }, 'CHECKS_NOT_VERIFIED'],
  ['failed check', (f) => { f.checkConclusion = 'failure'; }, 'CHECKS_NOT_VERIFIED'],
  ['unresolved thread', (f) => { f.unresolved = true; }, 'REVIEW_NOT_VERIFIED'],
  ['accepted status', (f) => { f.issue.fields.status.name = 'Done'; }, 'ISSUE_NOT_IN_REVIEW'],
]) {
  test(`${name} remains a blocking candidate result`, async () => {
    const f = fixture();
    change(f);
    const result = await diagnose(f);
    assert.equal(result.candidateGateResult, reason);
    assert.equal(result.readinessAuthorized, false);
  });
}

for (const [name, change] of Object.entries({
  status: (f) => { f.issue.fields.status.name = 'Done'; },
  'issue timestamp': (f) => { f.issue.fields.updated = '2026-01-02T00:00:00.000Z'; },
  'register revision': (f) => { f.scope.version++; },
  'new association': (f) => { f.prs.push({ ...f.prs[0], number: 3 }); },
  'renamed PR': (f) => { f.prs[0].title = 'Changed'; },
  'moved head': (f) => { f.prs[0].head.sha = 'f'.repeat(40); },
})) {
  test(`second collection rejects changed ${name}`, async () => {
    await assert.rejects(diagnose(fixture(), (f, url, calls) => {
      if (url.includes('fields=project') && calls.filter((c) => c.url.includes('fields=project')).length === 2) change(f);
    }), fail);
  });
}
test('a gate changing after the first pass does not inherit its earlier success', async () => {
  await assert.rejects(diagnose(fixture(), (f, url, calls) => {
    if (url.endsWith('/pulls/1') && calls.filter((c) => c.url.endsWith('/pulls/1')).length === 3) {
      f.checkConclusion = 'failure';
    }
  }), fail);
});
test('Jira changes during the second gate pass are still detected by the final source read', async () => {
  await assert.rejects(diagnose(fixture(), (f, url, calls) => {
    if (url.endsWith('/pulls/1') && calls.filter((c) => c.url.endsWith('/pulls/1')).length === 3) {
      f.issue.fields.status.name = 'Done';
    }
  }), fail);
});
test('inventory and single-PR head disagreement blocks before candidate evaluation', async () => {
  await assert.rejects(diagnose(fixture(), (f, url) => {
    if (url.endsWith('/pulls/1')) return response({ ...f.prs[0], head: { ...f.prs[0].head, sha: 'f'.repeat(40) } });
  }), fail);
});
test('malformed Jira scope, missing review and provider authorization failures are redacted', async () => {
  for (const replacement of [() => response({}), () => new Response(options.token, { status: 403 })]) {
    const lines = [];
    const result = await runReadinessDiagnostic({ ...options, ...transport(fixture(), (_f, url) => {
      if (url.includes('/properties/')) return replacement();
    }), write: (line) => lines.push(line) });
    assert.equal(result, 1);
    assert.equal(lines[0].includes(options.token), false);
    assert.equal(JSON.parse(lines[0]).readinessAuthorized, false);
  }
  await assert.rejects(diagnose(fixture(), (_f, url) => url.includes('/comments?') ? response([]) : undefined), fail);
});
test('complete output omits credentials, issue details, refs, PR content and decision keys', async () => {
  const lines = [];
  assert.equal(await runReadinessDiagnostic({ ...options, ...transport(fixture()), write: (line) => lines.push(line) }), 0);
  for (const value of [options.token, options.githubToken, options.email, options.cloudId, options.issueKey,
    'a'.repeat(40), 'Synthetic', 'floriankreutzer', 'decisionKey', 'targetStatus']) assert.equal(lines[0].includes(value), false);
});
test('overall clock budget bounds even individually fast collectors', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-06T00:00:00Z') });
  await assert.rejects(diagnose(fixture(), (_f, url) => {
    if (url.endsWith('/graphql')) context.mock.timers.tick(56000);
  }), fail);
});
test('excessive delivery scope is rejected before per-PR collection', async () => {
  const f = fixture();
  f.scope = null;
  f.prs = Array.from({ length: 21 }, (_, index) => ({ ...f.prs[0], number: index + 1 }));
  const t = transport(f);
  await assert.rejects(diagnoseJiraReadiness({ ...options, ...t }), fail);
  assert.equal(t.calls.some((c) => /\/pulls\/\d+$/.test(c.url)), false);
});
test('aggregate bytes are bounded across individually acceptable responses', async () => {
  const f = fixture();
  f.scope = null;
  f.prs = Array.from({ length: 20 }, (_, index) => ({ ...f.prs[0], number: index + 1 }));
  await assert.rejects(diagnose(f, (state, url) => {
    const match = url.match(/\/pulls\/(\d+)$/);
    if (match) return response({ ...state.prs.find((pr) => pr.number === Number(match[1])), padding: 'x'.repeat(3 * 1024 * 1024) });
  }), fail);
});
test('total request budget bounds a large scope even when every response is small', async () => {
  const f = fixture();
  f.scope = null;
  f.prs = Array.from({ length: 20 }, (_, index) => ({ ...f.prs[0], number: index + 1 }));
  const t = transport(f);
  await assert.rejects(diagnoseJiraReadiness({ ...options, ...t }), fail);
  assert.equal(t.calls.length, 512);
});
test('a provider failure cancels the other in-flight read instead of leaving background collection', async () => {
  let cancelled = false;
  await assert.rejects(diagnoseJiraReadiness({ ...options, fetchImpl: async (url, init) => {
    if (url.startsWith('https://api.atlassian.com')) return new Response(null, { status: 403 });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { cancelled = true; reject(new Error(options.githubToken)); }, { once: true });
    });
  } }), fail);
  assert.equal(cancelled, true);
});
test('redirected provider responses cannot be laundered by the aggregate budget wrapper', async () => {
  await assert.rejects(diagnose(fixture(), (_f, url) => {
    if (!url.includes('fields=project')) return undefined;
    const result = response(fixture().issue);
    Object.defineProperty(result, 'redirected', { value: true });
    return result;
  }), fail);
});
test('workflow binds both providers to main-only read access without a schedule or dependency install', async () => {
  const source = await readFile(new URL('../.github/workflows/jira-readiness-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /permission-pull-requests: read/);
  assert.match(source, /permission-checks: read/);
  assert.match(source, /permission-contents: read/);
  assert.doesNotMatch(source, /schedule:|pull_request_target:|permissions:[\s\S]*?write|npm (ci|install)/);
  assert.match(source, /CM_JIRA_ISSUE_KEY: \$\{\{ inputs.issue_key \}\}/);
  assert.match(source, /run: node scripts\/jira-readiness-diagnostic.mjs/);
});
