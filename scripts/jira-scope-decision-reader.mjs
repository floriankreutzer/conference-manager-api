import { normalizeJiraScopeDecision, parseJiraScopeDecision } from './jira-register-scope-revision.mjs';

const failure = () => new Error('JIRA_SCOPE_DECISION_READ_UNVERIFIED');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

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
      if (bytes > 64 * 1024) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function bounded(options, operation) {
  const { cloudId, issueKey, actorId, email, token, fetchImpl = fetch } = options;
  if (!matches(cloudId, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
    || !matches(issueKey, /^CO-[1-9][0-9]{0,8}$/) || !matches(actorId, /^[a-zA-Z0-9:-]{1,128}$/)
    || typeof email !== 'string' || email.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)
    || typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)) throw failure();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  try {
    const get = async path => {
      if (controller.signal.aborted) throw failure();
      const result = await json(await fetchImpl(`${base}${path}`, { method: 'GET', redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` } }));
      if (controller.signal.aborted) throw failure();
      return result;
    };
    const writer = await get('/myself');
    if (writer?.accountId !== actorId || writer.active !== true) throw failure();
    const result = await operation(get);
    if (controller.signal.aborted) throw failure();
    return result;
  } catch { throw failure(); }
  finally { controller.abort(); clearTimeout(timer); }
}

/** Identity binding only. The reviewed protected manual dispatch supplies authority. */
export async function readJiraScopeWriter(options = {}) {
  return bounded(options, async () => options.actorId);
}

function decisionText(body) {
  if (!keys(body, ['version', 'type', 'content']) || body.version !== 1 || body.type !== 'doc'
    || !Array.isArray(body.content) || body.content.length !== 1) throw failure();
  const block = body.content[0];
  if (!keys(block, ['type', 'attrs', 'content']) || block.type !== 'codeBlock'
    || !keys(block.attrs, ['language']) || block.attrs.language !== 'json'
    || !Array.isArray(block.content) || block.content.length < 1 || block.content.length > 16) throw failure();
  const text = block.content.map(part => {
    if (!keys(part, ['type', 'text']) || part.type !== 'text' || typeof part.text !== 'string') throw failure();
    return part.text;
  }).join('');
  if (Buffer.byteLength(text, 'utf8') > 16384) throw failure();
  return text;
}

/** No caller comment/body/author is trusted. Read one fixed issue/comment through the gateway. */
export async function readJiraScopeDecision(options = {}) {
  const { issueKey, commentId, expectedDecisionDigest, actorId } = options;
  if (!matches(commentId, /^[1-9][0-9]{0,19}$/) || !matches(expectedDecisionDigest, /^[a-f0-9]{64}$/)) throw failure();
  return bounded(options, async get => {
    const comment = await get(`/issue/${issueKey}/comment/${commentId}`);
    if (comment?.id !== commentId || comment.author?.accountId !== actorId || comment.author.active !== true
      || comment.updateAuthor?.accountId !== actorId || comment.updateAuthor.active !== true
      || !matches(comment.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:?\d{2})$/)
      || !Number.isFinite(Date.parse(comment.created)) || comment.created !== comment.updated) throw failure();
    const proof = normalizeJiraScopeDecision({ commentId, actorId, createdAt: new Date(comment.created).toISOString(),
      decisionText: decisionText(comment.body), decisionDigest: expectedDecisionDigest });
    if (parseJiraScopeDecision(proof.decisionText).issueKey !== issueKey) throw failure();
    return proof;
  });
}
