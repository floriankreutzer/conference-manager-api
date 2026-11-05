// Transport-only inventory. This is not sufficient evidence for a Jira transition.
const REPOSITORIES = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
const PAGE_SIZE = 100;
const MAX_PAGES = 11;
const MAX_BYTES = 4 * 1024 * 1024;

function failure() {
  return new Error('GITHUB_INVENTORY_UNVERIFIED');
}

async function readJson(response) {
  if (response.status !== 200 || response.redirected
    || !response.headers.get('content-type')?.includes('application/json') || !response.body) throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalize(pr, repository) {
  if (!pr || !Number.isSafeInteger(pr.number) || pr.number <= 0
    || typeof pr.title !== 'string' || pr.title.length > 1024
    || typeof pr.draft !== 'boolean' || !['open', 'closed'].includes(pr.state)
    || pr.base?.repo?.full_name !== repository
    || typeof pr.head?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(pr.head.sha)
    || typeof pr.head?.ref !== 'string' || pr.head.ref.length > 1024) throw failure();
  return { repository, number: pr.number, title: pr.title, draft: pr.draft,
    state: pr.state, headSha: pr.head.sha, headRef: pr.head.ref };
}

/** Enumerates all states without search-index filtering. Never infers merged or readiness. */
export async function collectGithubPrInventory({ token, fetchImpl = fetch } = {}) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) throw failure();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const startedAt = Date.now();
  const inventories = [];
  const pullRequests = [];
  try {
    for (const repository of REPOSITORIES) {
      const seen = new Set();
      let complete = false;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `https://api.github.com/repos/${repository}/pulls?state=all&sort=created&direction=asc&per_page=100&page=${page}`;
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28' },
        });
        const data = await readJson(response);
        if (!Array.isArray(data) || data.length > PAGE_SIZE) throw failure();
        for (const raw of data) {
          const pr = normalize(raw, repository);
          if (seen.has(pr.number) || seen.size >= 1000) throw failure();
          seen.add(pr.number);
          pullRequests.push(pr);
        }
        // Request an empty terminal page instead of trusting absent/malformed Link headers.
        if (data.length === 0) { complete = true; break; }
      }
      if (!complete || controller.signal.aborted) throw failure();
      inventories.push({ repository, authenticated: true, complete: true, nextPage: null,
        incompleteResults: false, count: seen.size, returnedCount: seen.size });
    }
    return { startedAt, collectedAt: Date.now(), inventories, pullRequests };
  } catch {
    // Neither token, provider payload nor transport error is propagated.
    throw failure();
  } finally {
    clearTimeout(timer);
  }
}
