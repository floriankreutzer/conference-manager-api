const failure = () => new Error('JIRA_READINESS_DISCOVERY_UNVERIFIED');
const JQL = 'project = CO AND status = "in Review" ORDER BY key ASC';

async function json(response) {
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure();
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 256 * 1024) throw failure(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Search discovers candidates only. Each selected issue still requires the complete fresh writer gates. */
export async function collectJiraReadinessCandidates({ cloudId, email, token, fetchImpl = fetch } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    if (typeof cloudId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(cloudId)
      || typeof email !== 'string' || email.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)
      || typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) throw failure();
    const keys = new Set(); const ids = new Set(); const cursors = new Set(); let cursor;
    for (let page = 0; page < 20; page++) {
      if (controller.signal.aborted) throw failure();
      const query = new URLSearchParams({ jql: JQL, fields: 'key,project,status', maxResults: '50', failFast: 'true' });
      if (cursor) query.set('nextPageToken', cursor);
      const result = await json(await fetchImpl(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql?${query}`, {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } }));
      if (!Array.isArray(result?.issues) || result.issues.length > 50 || typeof result.isLast !== 'boolean'
        || (result.warningMessages !== undefined && (!Array.isArray(result.warningMessages) || result.warningMessages.length))) {
        throw failure();
      }
      for (const issue of result.issues) {
        if (typeof issue?.key !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(issue.key) || keys.has(issue.key)
          || typeof issue.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(issue.id) || ids.has(issue.id)
          || issue.fields?.project?.key !== 'CO' || issue.fields.status?.name !== 'in Review') throw failure();
        keys.add(issue.key); ids.add(issue.id);
      }
      if (controller.signal.aborted) throw failure();
      if (result.isLast) {
        if (result.nextPageToken !== undefined && result.nextPageToken !== null && result.nextPageToken !== '') throw failure();
        return [...keys];
      }
      cursor = result.nextPageToken;
      if (!result.issues.length || typeof cursor !== 'string' || !cursor.length || cursor.length > 2048
        || cursors.has(cursor) || /[\r\n\x00]/.test(cursor)) throw failure();
      cursors.add(cursor);
    }
    throw failure();
  } catch { throw failure(); }
  finally { controller.abort(); clearTimeout(timer); }
}
