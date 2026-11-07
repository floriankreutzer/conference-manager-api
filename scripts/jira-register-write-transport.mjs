import { canonicalJiraRegister } from './jira-register-journal.mjs';
import { JIRA_REGISTER_PROPERTY, readJiraRegister } from './jira-register-reader.mjs';

const failure = () => new Error('JIRA_REGISTER_WRITE_UNVERIFIED');
const TASK_ID = /^[a-zA-Z0-9-]{1,100}$/;

function taskId(location, base) {
  if (typeof location !== 'string' || location.length > 2048) throw failure();
  const url = new URL(location, base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure();
  const match = /\/rest\/api\/3\/task\/([a-zA-Z0-9-]{1,100})$/.exec(url.pathname);
  if (!match) throw failure();
  // Location is never followed. Only the bounded opaque task ID is used against
  // the SAME fixed gateway and cloud that accepted this write request.
  return match[1];
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
      if (bytes > 256 * 1024) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Conditional transport only. Caller must hold the integration writer lease and
 * durably prepare the exact journal intent BEFORE invoking this mutation.
 * Never expose caller-supplied scopes as a public write/transition endpoint.
 */
export async function startJiraRegisterWrite({ cloudId, email, token, issueKey, issueId,
  expectedScope = null, nextScope, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const transport = (url, options) => fetchImpl(url, { ...options,
    signal: AbortSignal.any([controller.signal, options.signal]) });
  try {
    const next = canonicalJiraRegister(nextScope);
    const expected = expectedScope === null ? null : canonicalJiraRegister(expectedScope);
    const numericId = Number(issueId);
    if (typeof issueId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(issueId)
      || !Number.isSafeInteger(numericId) || numericId <= 0 || next.scope.issueKey !== issueKey
      || (expected && expected.scope.issueKey !== issueKey)
      || next.scope.version !== (expected?.scope.version ?? 0) + 1) throw failure();
    // Reuses the credential, issue/project identity and fixed-origin validation.
    const observed = await readJiraRegister({ cloudId, email, token, issueKey, fetchImpl: transport });
    const observedDigest = observed.scope === null ? null : canonicalJiraRegister(observed.scope).digest;
    if (observed.issueId !== issueId || observed.issueStatus !== 'in Review'
      || observedDigest !== (expected?.digest ?? null) || controller.signal.aborted) throw failure();
    const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
    const response = await transport(`${base}/issue/properties/${JIRA_REGISTER_PROPERTY}`, {
      method: 'PUT', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` },
      body: JSON.stringify({ filter: { entityIds: [numericId], hasProperty: expected !== null,
        ...(expected ? { currentValue: expected.scope } : {}) }, value: next.scope }),
    });
    try {
      if (response.status !== 303 || response.redirected || controller.signal.aborted) throw failure();
      return { taskId: taskId(response.headers.get('location'), base), digest: next.digest };
    } finally {
      await response.body?.cancel();
    }
  } catch {
    // A thrown error may follow a committed/scheduled write. Never retry it blindly.
    throw failure();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

/** One bounded task observation plus exact property readback; never polls or retries writes. */
export async function observeJiraRegisterWrite({ cloudId, email, token, issueKey, issueId,
  taskId: id, expectedScope, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const transport = (url, options) => fetchImpl(url, { ...options,
    signal: AbortSignal.any([controller.signal, options.signal]) });
  try {
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw failure();
    const expected = canonicalJiraRegister(expectedScope);
    const observed = await readJiraRegister({ cloudId, email, token, issueKey, fetchImpl: transport });
    if (observed.issueId !== issueId || expected.scope.issueKey !== issueKey) throw failure();
    const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
    const task = await json(await transport(`${base}/task/${id}`, { method: 'GET', redirect: 'error',
      signal: controller.signal, headers: { Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } }));
    if (task?.id !== id || !['ENQUEUED', 'RUNNING', 'COMPLETE'].includes(task.status)
      || controller.signal.aborted) throw failure();
    if (task.status !== 'COMPLETE') return { completed: false };
    // Read AFTER task completion, never qualify a value observed before completion.
    const final = await readJiraRegister({ cloudId, email, token, issueKey, fetchImpl: transport });
    if (final.issueId !== issueId || final.scope === null
      || canonicalJiraRegister(final.scope).digest !== expected.digest || controller.signal.aborted) throw failure();
    return { completed: true, scope: final.scope, digest: expected.digest };
  } catch {
    throw failure();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
