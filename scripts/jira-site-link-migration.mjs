import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object'
  && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fail = (reason) => { throw new Error(reason); };
const reasons = new Set(['CONFIGURATION', 'IDENTITY', 'TARGET_SITE', 'LINK_SCHEMA', 'FOREIGN_HOST',
  'PLAN_CHANGED', 'CONCURRENT_CHANGE', 'READBACK', 'RESPONSE', 'HTTP_401', 'HTTP_403', 'HTTP_404',
  'HTTP_429', 'HTTP_OTHER', 'TRANSPORT']);

function configuration(options) {
  const { cloudId, email, token, accountId, sourceHostHash, targetHostHash, links, mode, planDigest } = options;
  if (typeof cloudId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(cloudId)
    || typeof email !== 'string' || email.length > 254 || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email)
    || typeof token !== 'string' || token.length < 10 || token.length > 4096 || /\s/.test(token)
    || typeof accountId !== 'string' || !/^[a-zA-Z0-9:-]{1,128}$/.test(accountId)
    || !hashPattern.test(sourceHostHash) || !hashPattern.test(targetHostHash) || sourceHostHash === targetHostHash
    || typeof links !== 'string' || links.length > 4000 || !['preview', 'apply'].includes(mode)
    || (mode === 'apply' && !hashPattern.test(planDigest))) fail('CONFIGURATION');
  const entries = links.split(',').map((item) => {
    const match = /^(CO-[1-9][0-9]{0,8}|KNMCP-[1-9][0-9]{0,8}):([1-9][0-9]{0,15})$/.exec(item);
    if (!match) fail('CONFIGURATION');
    return { issueKey: match[1], linkId: match[2] };
  });
  if (entries.length > 100 || new Set(entries.map(canonical)).size !== entries.length) fail('CONFIGURATION');
  return entries.sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

function linkPayload(link, linkId) {
  if (!link || typeof link !== 'object' || Array.isArray(link) || String(link.id) !== linkId
    || Object.keys(link).some((key) => !['id', 'self', 'globalId', 'application', 'relationship', 'object'].includes(key))
    || !link.object || typeof link.object !== 'object' || Array.isArray(link.object)
    || typeof link.object.title !== 'string' || typeof link.object.url !== 'string'
    || link.object.url.length > 8192) fail('LINK_SCHEMA');
  // Jira PUT clears omitted fields. Retain every writable field, including opaque globalId and nested metadata.
  return { globalId: link.globalId ?? null, application: link.application ?? null,
    relationship: link.relationship ?? null, object: link.object };
}

function hostOf(url) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('FOREIGN_HOST'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\.atlassian\.net$/.test(parsed.hostname)
    || !url.startsWith(`https://${parsed.hostname}/`)) fail('FOREIGN_HOST');
  return parsed.hostname;
}

/** Explicit, bounded IDs only. No search, creation, deletion, register or workflow-status writes. */
export async function migrateJiraSiteLinks({ fetchImpl = fetch, write = console.log, ...options } = {}) {
  let phase = 'configuration';
  let verified = 0;
  let writeMayHaveCommitted = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  try {
    const entries = configuration(options);
    const { cloudId, email, token, accountId, sourceHostHash, targetHostHash, mode, planDigest } = options;
    const base = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
    let totalBytes = 0;
    async function request(path, body) {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const response = await fetchImpl(`${base}${path}`, { method: body ? 'PUT' : 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (signal.aborted || response.redirected) fail('RESPONSE');
      if (response.status !== (body ? 204 : 200)) {
        await response.body?.cancel();
        fail([401, 403, 404, 429].includes(response.status) ? `HTTP_${response.status}` : 'HTTP_OTHER');
      }
      if (body) { await response.body?.cancel(); return null; }
      if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        await response.body?.cancel(); fail('RESPONSE');
      }
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          totalBytes += chunk.value.byteLength;
          if (bytes > 256 * 1024 || totalBytes > 10 * 1024 * 1024 || signal.aborted) fail('RESPONSE');
          chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    phase = 'identity';
    const identity = await request('/myself');
    if (identity?.accountId !== accountId || identity.active !== true) fail('IDENTITY');
    phase = 'site';
    const site = await request('/serverInfo');
    const target = hostOf(`${String(site?.baseUrl).replace(/\/$/, '')}/`);
    if (digest(target) !== targetHostHash) fail('TARGET_SITE');
    phase = 'preview';
    const plan = [];
    for (const entry of entries) {
      const path = `/issue/${entry.issueKey}/remotelink/${entry.linkId}`;
      const before = linkPayload(await request(path), entry.linkId);
      const source = hostOf(before.object.url);
      const hostHash = digest(source);
      if (![sourceHostHash, targetHostHash].includes(hostHash)) fail('FOREIGN_HOST');
      const after = { ...before, object: { ...before.object,
        url: `https://${target}${before.object.url.slice(`https://${source}`.length)}` } };
      plan.push({ ...entry, path, before, after, changed: hostHash !== targetHostHash });
    }
    const actualDigest = digest(canonical({ cloudId, accountId, sourceHostHash, targetHostHash, plan }));
    const changed = plan.filter((entry) => entry.changed);
    if (mode === 'apply' && actualDigest !== planDigest) fail('PLAN_CHANGED');
    if (mode === 'apply') {
      for (const entry of changed) {
        phase = 'recheck';
        if (canonical(linkPayload(await request(entry.path), entry.linkId)) !== canonical(entry.before)) fail('CONCURRENT_CHANGE');
        phase = 'write';
        writeMayHaveCommitted = true;
        await request(entry.path, entry.after);
        phase = 'readback';
        if (canonical(linkPayload(await request(entry.path), entry.linkId)) !== canonical(entry.after)) fail('READBACK');
        verified++;
        writeMayHaveCommitted = false;
      }
      phase = 'final_readback';
      for (const entry of plan) {
        if (canonical(linkPayload(await request(entry.path), entry.linkId)) !== canonical(entry.after)) fail('READBACK');
      }
    }
    write(JSON.stringify({ result: mode === 'apply' ? 'JIRA_LINK_MIGRATION_VERIFIED' : 'JIRA_LINK_MIGRATION_PREVIEW',
      selected: plan.length, proposed: changed.length, verified, alreadyCurrent: plan.length - changed.length,
      planDigest: actualDigest, mutationPerformed: verified > 0 }));
    return 0;
  } catch (error) {
    write(JSON.stringify({ result: 'JIRA_LINK_MIGRATION_UNVERIFIED', phase,
      reason: reasons.has(error?.message) ? error.message : 'TRANSPORT', verified, writeMayHaveCommitted }));
    return 1;
  } finally { controller.abort(); clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await migrateJiraSiteLinks({ cloudId: process.env.CM_JIRA_CLOUD_ID,
    email: process.env.CM_JIRA_WRITER_EMAIL, token: process.env.CM_JIRA_WRITER_API_TOKEN,
    accountId: process.env.CM_JIRA_WRITER_ACCOUNT_ID, sourceHostHash: process.env.CM_SOURCE_HOST_HASH,
    targetHostHash: process.env.CM_TARGET_HOST_HASH, links: process.env.CM_LINK_IDS,
    mode: process.env.CM_MIGRATION_MODE, planDigest: process.env.CM_PLAN_DIGEST });
}
