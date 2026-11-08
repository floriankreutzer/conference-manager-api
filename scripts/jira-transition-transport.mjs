import { readJiraRegister } from './jira-register-reader.mjs';

const failure = () => new Error('JIRA_TRANSITION_TRANSPORT_UNVERIFIED');
const ID = /^[1-9][0-9]{0,19}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const oversizedResponse = Symbol('oversized Jira response');
export const JIRA_TRANSITION_HISTORY_TYPE = 'cm.delivery.readiness.v1';
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

function connection({ cloudId, email, token, issueKey, issueId } = {}) {
  if (!matches(cloudId, UUID) || !matches(issueKey, /^CO-[1-9][0-9]{0,8}$/) || !matches(issueId, ID)
    || typeof email !== 'string' || email.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)
    || typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) throw failure();
  return { base: `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${issueKey}`,
    headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } };
}

async function json(response) {
  if (response.status !== 200 || response.redirected || !response.body
    || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw oversizedResponse;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function bounded(options, action) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const config = connection(options);
    const get = async path => json(await (options.fetchImpl ?? fetch)(`${config.base}${path}`, {
      method: 'GET', redirect: 'error', signal: controller.signal, headers: config.headers }));
    const result = await action({ ...config, get, signal: controller.signal });
    if (controller.signal.aborted) throw failure();
    return result;
  } catch { throw failure(); }
  finally { controller.abort(); clearTimeout(timer); }
}

/** Resolve the target STATUS, never the human transition name. Global transitions
 * cannot enforce the source-state boundary and are deliberately unsupported.
 */
export async function readJiraReadyTransition(options = {}) {
  return bounded(options, async ({ get, signal }) => {
    const jira = await readJiraRegister({ ...options, fetchImpl: (url, request) =>
      (options.fetchImpl ?? fetch)(url, { ...request, signal: AbortSignal.any([signal, request.signal]) }) });
    const issue = await get('?fields=status');
    if (jira.issueId !== options.issueId || jira.issueStatus !== 'in Review'
      || issue?.id !== options.issueId || issue.key !== options.issueKey
      || issue.fields?.status?.name !== 'in Review' || !matches(issue.fields.status.id, ID)) throw failure();
    const data = await get('/transitions?expand=transitions.fields');
    if (!Array.isArray(data?.transitions) || data.transitions.length > 100) throw failure();
    const found = data.transitions.filter(item => item?.to?.name === 'Ready for Deployment');
    if (found.length !== 1) throw failure();
    const value = found[0];
    if (!matches(value.id, ID) || !matches(value.to.id, ID) || value.to.id === issue.fields.status.id
      || value.to.statusCategory?.key !== 'indeterminate' || value.isGlobal !== false
      || value.isInitial === true || value.isAvailable !== true || value.hasScreen !== false
      || !value.fields || typeof value.fields !== 'object' || Array.isArray(value.fields)
      || Object.values(value.fields).some(field => field?.required !== false)) throw failure();
    return { jira, transitionId: value.id, sourceStatusId: issue.fields.status.id,
      targetStatusId: value.to.id, issueUpdatedAt: jira.issueUpdatedAt };
  });
}

function validateAttempt(attempt) {
  if (!attempt || attempt.state !== 'pending' || !matches(attempt.attemptId, UUID)
    || !matches(attempt.decisionKey, HASH) || !matches(attempt.registerDigest, HASH)
    || !matches(attempt.actorId, /^[a-zA-Z0-9:-]{1,128}$/)
    || !matches(attempt.transitionId, ID) || !matches(attempt.sourceStatusId, ID)
    || !matches(attempt.targetStatusId, ID) || attempt.sourceStatusId === attempt.targetStatusId
    || !Number.isFinite(Date.parse(attempt.createdAt))) throw failure();
}

/** Internal one-shot transport. The trusted composition must retain the issue
 * lock, a fresh gate decision and a NEW committed claim. This is not an endpoint.
 * Any error may follow a successful remote transition; never repeat this POST.
 */
export async function submitJiraReadyTransition({ attempt, ...options } = {}) {
  validateAttempt(attempt);
  return bounded(options, async ({ base, headers, signal }) => {
    const response = await (options.fetchImpl ?? fetch)(`${base}/transitions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: attempt.transitionId }, historyMetadata: {
        type: JIRA_TRANSITION_HISTORY_TYPE, extraData: { attemptId: attempt.attemptId,
          decisionKey: attempt.decisionKey, registerDigest: attempt.registerDigest } } }),
    });
    try { if (response.status !== 204 || response.redirected) throw failure(); }
    finally { await response.body?.cancel(); }
  });
}

/** Read-only recovery uses immutable Jira history with the actual writer actor,
 * random attempt identity and exact from/to IDs. Current status alone is no receipt.
 */
export async function observeJiraReadyTransition({ attempt, ...options } = {}) {
  validateAttempt(attempt);
  return bounded(options, async ({ get, signal }) => {
    const jira = await readJiraRegister({ ...options, fetchImpl: (url, request) =>
      (options.fetchImpl ?? fetch)(url, { ...request, signal: AbortSignal.any([signal, request.signal]) }) });
    if (jira.issueId !== options.issueId) throw failure();
    const seen = new Set();
    const matching = [];
    let offset = 0;
    let total = null;
    let pageSize = 100;
    let requests = 0;
    while (true) {
      if (++requests > 100) throw failure();
      let page;
      try {
        page = await get(`/changelog?startAt=${offset}&maxResults=${pageSize}`);
      } catch (error) {
        // Only an oversized read may be retried, at the SAME offset with fewer
        // entries. Never raise the byte limit, skip history or retry a POST.
        if (error !== oversizedResponse || pageSize === 1) throw failure();
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        continue;
      }
      if (page?.startAt !== offset || !Number.isSafeInteger(page.total) || page.total < 0 || page.total > 1000
        || (total !== null && total !== page.total) || !Array.isArray(page.values) || page.values.length > pageSize
        || typeof page.isLast !== 'boolean') throw failure();
      total = page.total;
      for (const row of page.values) {
        if (!matches(row?.id, ID) || seen.has(row.id)) throw failure();
        seen.add(row.id);
        const metadata = row.historyMetadata;
        if (metadata?.extraData?.attemptId !== attempt.attemptId) continue;
        const time = Date.parse(row.created);
        if (metadata.type !== JIRA_TRANSITION_HISTORY_TYPE || metadata.extraData.decisionKey !== attempt.decisionKey
          || metadata.extraData.registerDigest !== attempt.registerDigest || row.author?.accountId !== attempt.actorId
          || !Number.isFinite(time) || time < Date.parse(attempt.createdAt) - 60000 || time > Date.now() + 60000
          || !Array.isArray(row.items) || row.items.length > 100) throw failure();
        const status = row.items.filter(item => item?.field === 'status');
        if (status.length !== 1 || status[0].fieldtype !== 'jira'
          || (status[0].fieldId !== undefined && status[0].fieldId !== 'status')
          || status[0].from !== attempt.sourceStatusId || status[0].to !== attempt.targetStatusId) throw failure();
        matching.push(row.id);
      }
      offset += page.values.length;
      if (offset > total || page.isLast !== (offset === total)) throw failure();
      if (page.isLast) break;
      if (!page.values.length) throw failure();
    }
    if (matching.length > 1) throw failure();
    return matching.length === 0 ? { completed: false } : { completed: true, historyId: matching[0],
      atTarget: jira.issueStatus === 'Ready for Deployment' };
  });
}
