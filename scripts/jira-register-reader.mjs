import { reconcileJiraPrScope } from './jira-pr-scope.mjs';

export const JIRA_REGISTER_PROPERTY = 'cm.delivery.pr-register.v1';
const failure = () => new Error('JIRA_REGISTER_READ_UNVERIFIED');
const MAX_BYTES = 256 * 1024;

async function json(response) {
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Authenticated read only. Transport identity does not establish register-writer authority. */
export async function readJiraRegister({ cloudId, email, token, issueKey, fetchImpl = fetch } = {}) {
  if (typeof cloudId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(cloudId)
    || typeof email !== 'string' || email.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)
    || typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)
    || typeof issueKey !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(issueKey)) throw failure();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}`;
  const options = { method: 'GET', redirect: 'error', signal: controller.signal,
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } };
  try {
    const issue = await json(await fetchImpl(`${base}?fields=project,status,updated`, options));
    if (!issue || issue.key !== issueKey || typeof issue.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(issue.id)
      || issue.fields?.project?.key !== 'CO' || typeof issue.fields.status?.name !== 'string'
      || issue.fields.status.name.length === 0 || issue.fields.status.name.length > 100
      || typeof issue.fields.updated !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})$/.test(issue.fields.updated)
      || !Number.isFinite(Date.parse(issue.fields.updated))) throw failure();
    const response = await fetchImpl(`${base}/properties/${JIRA_REGISTER_PROPERTY}`, options);
    let scope = null;
    if (response.status === 404 && !response.redirected) {
      // A missing property is enrollment-needed, never a complete empty register.
      await response.body?.cancel();
    } else {
      const property = await json(response);
      if (property?.key !== JIRA_REGISTER_PROPERTY || property.value?.issueKey !== issueKey
        || !reconcileJiraPrScope(property.value, { issueKey, complete: true, stale: false,
          pullRequests: property.value.entries }).complete) throw failure();
      scope = property.value;
    }
    if (controller.signal.aborted) throw failure();
    return { issueKey, issueId: issue.id, issueStatus: issue.fields.status.name,
      issueUpdatedAt: issue.fields.updated, scope, enrollmentRequired: scope === null };
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
  }
}
