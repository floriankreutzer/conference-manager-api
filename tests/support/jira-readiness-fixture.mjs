import assert from 'node:assert/strict';

const repositories = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
export const options = { cloudId: '12345678-1234-1234-1234-123456789abc', email: 'reader@example.test',
  token: 'jira-test-only-value', githubToken: 'github-test-only-value', issueKey: 'CO-296', actorId: 'synthetic-writer' };
export const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
export function fixture(issueKey = options.issueKey) {
  const config = { ...options, issueKey };
  const prs = repositories.map((repository, index) => ({ number: index + 1, title: `${issueKey} Synthetic change`,
    draft: false, state: 'closed', merged: true, merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: 'c'.repeat(40), user: { id: 7 }, base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: (index ? 'b' : 'a').repeat(40), ref: `${issueKey}-synthetic` } }));
  return { options: config, posts: 0, histories: [], prs, scope: { schemaVersion: 1, issueKey, version: 1, closed: true,
    entries: prs.map((pr) => ({ repository: pr.base.repo.full_name, number: pr.number, kind: 'delivery' })) },
  issue: { id: '10001', key: issueKey, fields: { project: { key: 'CO' }, status: { id: '10004', name: 'in Review' },
    updated: '2026-01-01T00:00:00.000Z' } }, checkStatus: 'completed', checkConclusion: 'success', unresolved: false };
}

export function transport(f, mutate = () => {}) {
  const options = f.options;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const override = mutate(f, url, calls);
    if (override) return override;
    const parsed = new URL(url);
    if (parsed.origin === 'https://api.atlassian.com') {
      if (parsed.pathname.endsWith('/transitions') && init.method === 'POST') {
        f.posts++;
        if (f.rejectPost) return new Response(null, { status: 403 });
        assert.equal(f.issue.fields.status.name, 'in Review');
        const body = JSON.parse(init.body);
        assert.deepEqual(body.transition, { id: '2' });
        f.histories.push({ id: String(f.histories.length + 1), created: new Date().toISOString(),
          author: { accountId: options.actorId }, historyMetadata: body.historyMetadata,
          items: [{ field: 'status', fieldId: 'status', fieldtype: 'jira', from: '10004', to: '10009' }] });
        f.issue.fields.status = { id: '10009', name: 'Ready for Deployment' };
        f.issue.fields.updated = new Date().toISOString();
        if (f.unknownPost) throw new Error('private failure after accepted transition');
        return new Response(null, { status: 204 });
      }
      assert.equal(init.method, 'GET');
      if (parsed.pathname.endsWith('/transitions')) return response({ transitions: [{
        id: '2', name: 'to Ready for Development', hasScreen: false, isGlobal: false,
        isAvailable: true, isInitial: false, fields: {},
        to: { id: '10009', name: 'Ready for Deployment', statusCategory: { key: 'indeterminate' } },
        ...f.transitionOverride,
      }] });
      if (parsed.pathname.endsWith('/changelog')) {
        const offset = Number(parsed.searchParams.get('startAt'));
        const size = Number(parsed.searchParams.get('maxResults'));
        assert.ok(Number.isSafeInteger(size) && size >= 1 && size <= 100);
        return response({ startAt: offset, maxResults: size, total: f.histories.length,
          isLast: offset + size >= f.histories.length, values: f.histories.slice(offset, offset + size) });
      }
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`);
      if (parsed.pathname.endsWith('/properties/cm.delivery.pr-register.v1')) {
        return f.scope === null ? new Response(null, { status: 404 })
          : response({ key: 'cm.delivery.pr-register.v1', value: f.scope });
      }
      assert.equal(parsed.pathname, `/ex/jira/${options.cloudId}/rest/api/3/issue/${options.issueKey}`);
      return response(f.issue);
    }
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(init.headers.Authorization, `Bearer ${options.githubToken}`);
    if (parsed.pathname === '/graphql') {
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.ok(body.query.startsWith('query('));
      const repository = `floriankreutzer/${body.variables.name}`;
      const pr = f.prs.find((p) => p.base.repo.full_name === repository && p.number === body.variables.number);
      return response({ data: { repository: { nameWithOwner: repository, pullRequest: {
        number: pr.number, headRefOid: pr.head.sha,
        reviewThreads: { nodes: [{ id: 'thread', isResolved: !f.unresolved }],
          pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    assert.equal(init.method, 'GET');
    const repository = parsed.pathname.split('/').slice(2, 4).join('/');
    assert.ok(repositories.includes(repository));
    const path = parsed.pathname.split('/').slice(4).join('/');
    const page = Number(parsed.searchParams.get('page'));
    const pr = f.prs.find((p) => p.base.repo.full_name === repository
      && (path.includes('/check-runs') ? path.includes(p.head.sha) : p.number === Number(path.split('/')[1])));
    if (path === 'pulls') return response(page === 1 ? f.prs.filter((p) => p.base.repo.full_name === repository) : []);
    if (/^pulls\/\d+$/.test(path)) return response(pr);
    if (path === 'branches/main') return response({ name: 'main', protected: true, protection: { enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } });
    if (path === 'rules/branches/main') return response(page === 1 ? [
      { ruleset_id: 1, type: 'pull_request', parameters: { required_approving_review_count: 0,
        require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true } },
      { ruleset_id: 1, type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'quality', integration_id: 15368 }] } },
    ] : []);
    if (path.endsWith('/check-runs')) return response({ total_count: 1, check_runs: page === 1
      ? [{ id: 1, name: 'quality', head_sha: pr.head.sha, app: { id: 15368 },
        status: f.checkStatus, conclusion: f.checkConclusion }] : [] });
    if (path.endsWith('/reviews')) return response([]);
    if (path.endsWith('/comments')) return response(page === 1 ? [{ id: 1,
      user: { id: 199175422, type: 'Bot', login: 'chatgpt-codex-connector[bot]' },
      body: '<!-- codex-review-state:v1 ' + JSON.stringify({ code_review: { commit_sha: pr.head.sha,
        status: 'completed', has_any_findings: false, has_unresolved_findings: false } }) + ' -->' }] : []);
    assert.fail('unexpected provider path');
  };
  return { fetchImpl, calls };
}
