import { createHash } from 'node:crypto';

const REPOSITORIES = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
const SHA = /^[a-f0-9]{40}$/;
const validSha = (value) => typeof value === 'string' && SHA.test(value);
const BOT_ID = 199175422;
const failure = () => new Error('GITHUB_PR_GATES_UNVERIFIED');
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const threadsQuery = `query($name:String!,$number:Int!,$cursor:String) {
  repository(owner:"floriankreutzer",name:$name) { nameWithOwner
    pullRequest(number:$number) { number headRefOid
      reviewThreads(first:100,after:$cursor) { nodes { id isResolved }
        pageInfo { hasNextPage endCursor } }
    }
  }
}`;

async function json(response) {
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function pages(request, path, select = (value) => value, identify = (item) => positive(item?.id) ? item.id : null) {
  const all = [];
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= 11; page++) {
    const raw = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = select(raw);
    if (!Array.isArray(items) || items.length > 100) throw failure();
    if (Object.hasOwn(raw, 'total_count')) {
      if (!Number.isSafeInteger(raw.total_count) || raw.total_count < 0 || raw.total_count > 1000
        || (total !== null && raw.total_count !== total)) throw failure();
      total = raw.total_count;
    }
    for (const item of items) {
      const id = identify(item);
      if (id === null || seen.has(id) || all.length >= 1000) throw failure();
      seen.add(id);
      all.push(item);
    }
    if (items.length === 0) {
      if (total !== null && total !== all.length) throw failure();
      return all;
    }
  }
  throw failure();
}

function effectiveRules(request, root) {
  return pages(request, `${root}/rules/branches/main`, (value) => value, (rule) =>
    positive(rule?.ruleset_id) && typeof rule.type === 'string' ? `${rule.ruleset_id}:${rule.type}` : null);
}

function policy(rules) {
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 100) throw failure();
  const checks = new Map();
  let review = false;
  for (const rule of rules) {
    if (!['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].includes(rule?.type)) throw failure();
    if (rule.type === 'required_status_checks') {
      const parameters = rule.parameters;
      if (parameters?.strict_required_status_checks_policy !== true
        || !Array.isArray(parameters.required_status_checks) || parameters.required_status_checks.length === 0) throw failure();
      for (const check of parameters.required_status_checks) {
        if (typeof check.context !== 'string' || check.context.length === 0 || check.context.length > 200
          || !positive(check.integration_id)) throw failure();
        checks.set(`${check.integration_id}:${check.context}`, { name: check.context, appId: check.integration_id });
      }
    }
    if (rule.type === 'pull_request') {
      const p = rule.parameters;
      // Nonzero approvals/code-owner policies require a separately qualified reviewer
      // permission collector. Never infer valid human approvals from comment text.
      if (p?.required_approving_review_count !== 0 || p.require_code_owner_review !== false
        || p.require_last_push_approval !== false || p.required_review_thread_resolution !== true
        || (p.required_reviewers !== undefined && (!Array.isArray(p.required_reviewers) || p.required_reviewers.length))) {
        throw failure();
      }
      review = true;
    }
  }
  if (!review || checks.size === 0 || checks.size > 100) throw failure();
  return { requiredChecks: [...checks.values()].sort((a, b) => `${a.appId}:${a.name}`.localeCompare(`${b.appId}:${b.name}`)),
    policyRevision: createHash('sha1').update(JSON.stringify(rules)).digest('hex'), requiredApprovals: 0, policyComplete: true };
}

function legacyPolicy(branch) {
  // Effective rulesets do not include classic branch protection. This collector
  // supports the verified ruleset-only profile, not an unknown classic policy.
  const checks = branch?.protection?.required_status_checks;
  if (branch?.name !== 'main' || branch.protected !== true || branch.protection?.enabled !== false
    || checks?.enforcement_level !== 'off' || !Array.isArray(checks.contexts) || checks.contexts.length
    || !Array.isArray(checks.checks) || checks.checks.length) throw failure();
  return JSON.stringify(branch.protection);
}

function checkEvidence(runs, required, headSha) {
  const latest = new Map();
  for (const run of runs) {
    if (run.head_sha !== headSha || !positive(run.app?.id) || typeof run.name !== 'string'
      || typeof run.status !== 'string') throw failure();
    const key = `${run.app.id}:${run.name}`;
    if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, run);
  }
  return required.map(({ name, appId }) => {
    const run = latest.get(`${appId}:${name}`);
    if (!run) throw failure();
    // Keep newer queued/failed attempts; never fall back to historical success.
    return { name, appId, headSha, status: run.status, conclusion: run.conclusion };
  });
}

function reviewEvidence(comments, reviews, headSha, authorId) {
  const summaries = comments.filter((comment) => comment.user?.id === BOT_ID
    && comment.user?.type === 'Bot' && comment.user?.login === 'chatgpt-codex-connector[bot]'
    && typeof comment.body === 'string' && comment.body.includes('<!-- codex-review-state:v1 '));
  // Ambiguous summaries require reconciliation, not selection of a convenient success.
  if (summaries.length !== 1 || summaries[0].body.length > 100000) throw failure();
  const matches = [...summaries[0].body.matchAll(/<!-- codex-review-state:v1 (.*?) -->/g)];
  if (matches.length !== 1) throw failure();
  const code = JSON.parse(matches[0][1]).code_review;
  if (code?.commit_sha !== headSha || code.status !== 'completed'
    || typeof code.has_any_findings !== 'boolean' || typeof code.has_unresolved_findings !== 'boolean') throw failure();
  const latest = new Map();
  for (const review of reviews) {
    if (!positive(review.user?.id) || !validSha(review.commit_id)
      || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(review.state)) throw failure();
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    if (!latest.has(review.user.id) || latest.get(review.user.id).id < review.id) latest.set(review.user.id, review);
  }
  return { reviewHeadSha: headSha, reviewCompleted: true, reviewsComplete: true,
    unresolvedFindings: code.has_unresolved_findings ? 1 : 0,
    changesRequested: [...latest.values()].some((review) => review.state === 'CHANGES_REQUESTED'),
    validApprovals: [...latest.values()].filter((review) => review.state === 'APPROVED'
      && review.commit_id === headSha && review.user.id !== authorId).length };
}

function prIdentity(pr, repository, number) {
  if (pr?.number !== number || pr.base?.repo?.full_name !== repository || pr.base.ref !== 'main'
    || !validSha(pr.head?.sha) || typeof pr.draft !== 'boolean' || !['open', 'closed'].includes(pr.state)
    || typeof pr.merged !== 'boolean' || !positive(pr.user?.id)
    || (pr.merged && (!validSha(pr.merge_commit_sha) || typeof pr.merged_at !== 'string'
      || !Number.isFinite(Date.parse(pr.merged_at))))) throw failure();
  return { repository, number, draft: pr.draft, state: pr.state, merged: pr.merged,
    headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged ? Date.parse(pr.merged_at) : null };
}

async function unresolvedThreads(request, repository, number, headSha) {
  const seen = new Set();
  const cursors = new Set();
  let cursor = null;
  let unresolved = 0;
  for (let page = 0; page < 10; page++) {
    const data = await request('/graphql', { query: threadsQuery,
      variables: { name: repository.split('/')[1], number, cursor } });
    if (data.errors !== undefined || data.data?.repository?.nameWithOwner !== repository) throw failure();
    const pr = data.data.repository.pullRequest;
    const threads = pr?.reviewThreads;
    if (pr?.number !== number || pr.headRefOid !== headSha || !Array.isArray(threads?.nodes)
      || threads.nodes.length > 100 || typeof threads.pageInfo?.hasNextPage !== 'boolean') throw failure();
    for (const thread of threads.nodes) {
      if (typeof thread?.id !== 'string' || !thread.id || seen.has(thread.id) || typeof thread.isResolved !== 'boolean') throw failure();
      seen.add(thread.id);
      if (!thread.isResolved) unresolved++;
    }
    if (!threads.pageInfo.hasNextPage) return unresolved;
    cursor = threads.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursor.length > 1000 || cursors.has(cursor)) throw failure();
    cursors.add(cursor);
  }
  throw failure();
}

/** Read-only evidence collector. Does not establish scope, persist a register or authorize a transition. */
export async function collectGithubPrGates({ token, repository, number, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)
    || !REPOSITORIES.includes(repository) || !positive(number)) throw failure();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const startedAt = Date.now();
  const root = `/repos/${repository}`;
  const request = async (path, body) => json(await fetchImpl(`https://api.github.com${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  try {
    const rawPr = await request(`${root}/pulls/${number}`);
    const pr = prIdentity(rawPr, repository, number);
    const legacy = legacyPolicy(await request(`${root}/branches/main`));
    const rules = await effectiveRules(request, root);
    const requirements = policy(rules);
    const runs = await pages(request, `${root}/commits/${pr.headSha}/check-runs?filter=all`, (raw) => {
      if (!Number.isSafeInteger(raw?.total_count)) throw failure();
      return raw.check_runs;
    });
    const reviews = await pages(request, `${root}/pulls/${number}/reviews`);
    const comments = await pages(request, `${root}/issues/${number}/comments`);
    const threads = await unresolvedThreads(request, repository, number, pr.headSha);
    const finalPr = prIdentity(await request(`${root}/pulls/${number}`), repository, number);
    const finalRules = await effectiveRules(request, root);
    const finalLegacy = legacyPolicy(await request(`${root}/branches/main`));
    if (JSON.stringify(pr) !== JSON.stringify(finalPr) || JSON.stringify(rules) !== JSON.stringify(finalRules)
      || legacy !== finalLegacy || controller.signal.aborted || Date.now() - startedAt > 45000) throw failure();
    return { ...pr, ...requirements, ...reviewEvidence(comments, reviews, pr.headSha, rawPr.user.id),
      checksHeadSha: pr.headSha, checksComplete: true, checks: checkEvidence(runs, requirements.requiredChecks, pr.headSha),
      unresolvedThreads: threads, startedAt, collectedAt: Date.now() };
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
  }
}
