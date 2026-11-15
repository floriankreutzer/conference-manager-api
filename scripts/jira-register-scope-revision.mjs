import { createHash } from 'node:crypto';
import { reconcileJiraPrScope } from './jira-pr-scope.mjs';

const failure = () => new Error('JIRA_SCOPE_REVISION_UNVERIFIED');
const repositories = new Set(['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api']);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const identity = value => `${value.repository}#${value.number}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function reference(value) {
  if (!keys(value, ['repository', 'number', 'headSha']) || !repositories.has(value.repository)
    || !Number.isSafeInteger(value.number) || value.number < 1
    || !matches(value.headSha, /^[a-f0-9]{40}$/)) throw failure();
  return { repository: value.repository, number: value.number, headSha: value.headSha };
}

/** A deliberately small, explicit decision format; it is not an authorization source. */
export function parseJiraScopeDecision(text) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 16384) throw failure();
    const value = JSON.parse(text);
    // Accept JSON.stringify spelling with optional JSON whitespace. Duplicate keys,
    // alternate escapes and lossy numeric spellings cannot hide in approved bytes.
    const compact = text.replace(/("(?:\\[\s\S]|[^"\\])*")|[ \t\r\n]+/g, (all, string) => string ?? '');
    if (JSON.stringify(value) !== compact || !keys(value,
      ['schemaVersion', 'operation', 'issueKey', 'expectedRegisterVersion', 'expectedRegisterDigest', 'supersessions'])
      || value.schemaVersion !== 1 || value.operation !== 'supersede'
      || !matches(value.issueKey, /^CO-[1-9][0-9]{0,8}$/)
      || !Number.isSafeInteger(value.expectedRegisterVersion) || value.expectedRegisterVersion < 1
      || value.expectedRegisterVersion >= 2147483647
      || !matches(value.expectedRegisterDigest, /^[a-f0-9]{64}$/)
      || !Array.isArray(value.supersessions) || value.supersessions.length < 1
      || value.supersessions.length > 20) throw failure();
    const seen = new Set();
    const supersessions = value.supersessions.map(change => {
      if (!keys(change, ['repository', 'number', 'headSha', 'replacedBy', 'reason'])) throw failure();
      const source = reference({ repository: change.repository, number: change.number, headSha: change.headSha });
      const replacedBy = reference(change.replacedBy);
      if (source.repository !== replacedBy.repository || identity(source) === identity(replacedBy)
        || seen.has(identity(source)) || typeof change.reason !== 'string'
        || change.reason.trim() !== change.reason || !change.reason.length || change.reason.length > 1000
        || /[\u0000-\u001f\u007f]/.test(change.reason)) throw failure();
      seen.add(identity(source));
      return { ...source, replacedBy, reason: change.reason };
    });
    return { schemaVersion: 1, operation: 'supersede', issueKey: value.issueKey,
      expectedRegisterVersion: value.expectedRegisterVersion, expectedRegisterDigest: value.expectedRegisterDigest,
      supersessions };
  } catch { throw failure(); }
}

/** Snapshot of an authenticated, unedited Jira comment. No display names or raw response. */
export function normalizeJiraScopeDecision(proof) {
  if (!keys(proof, ['commentId', 'actorId', 'createdAt', 'decisionText', 'decisionDigest'])
    || !matches(proof.commentId, /^[1-9][0-9]{0,19}$/)
    || !matches(proof.actorId, /^[a-zA-Z0-9:-]{1,128}$/)
    || !matches(proof.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    || !Number.isFinite(Date.parse(proof.createdAt)) || new Date(proof.createdAt).toISOString() !== proof.createdAt
    || !matches(proof.decisionDigest, /^[a-f0-9]{64}$/)) throw failure();
  parseJiraScopeDecision(proof.decisionText);
  if (sha256(proof.decisionText) !== proof.decisionDigest) throw failure();
  return { commentId: proof.commentId, actorId: proof.actorId, createdAt: proof.createdAt,
    decisionText: proof.decisionText, decisionDigest: proof.decisionDigest };
}

/** Supplied by the protected first-attempt manual runner, never Jira comment content. */
export function normalizeJiraScopeExecution(execution) {
  if (!keys(execution, ['sourceSha', 'runId', 'runAttempt', 'githubActorId'])
    || !matches(execution.sourceSha, /^[a-f0-9]{40}$/)
    || !matches(execution.runId, /^[1-9][0-9]{0,19}$/) || execution.runAttempt !== 1
    || !matches(execution.githubActorId, /^[1-9][0-9]{0,19}$/)) throw failure();
  return { sourceSha: execution.sourceSha, runId: execution.runId,
    runAttempt: 1, githubActorId: execution.githubActorId };
}

/** Derive only named supersessions from a confirmed, canonical journal checkpoint. */
export function deriveJiraScopeRevision(current, proof) {
  const decision = parseJiraScopeDecision(normalizeJiraScopeDecision(proof).decisionText);
  if (!current || current.state !== 'confirmed' || current.digest !== decision.expectedRegisterDigest
    || current.scope?.version !== decision.expectedRegisterVersion || current.scope.issueKey !== decision.issueKey
    || !reconcileJiraPrScope(current.scope, { issueKey: decision.issueKey, complete: true, stale: false,
      pullRequests: current.scope.entries }).complete) throw failure();
  const entries = new Map(current.scope.entries.map(entry => [identity(entry), structuredClone(entry)]));
  for (const change of decision.supersessions) {
    if (entries.get(identity(change))?.kind !== 'delivery') throw failure();
    const target = entries.get(identity(change.replacedBy));
    if (target && target.kind !== 'delivery') throw failure();
    entries.set(identity(change), { repository: change.repository, number: change.number, kind: 'superseded',
      reason: change.reason, replacedBy: { repository: change.replacedBy.repository, number: change.replacedBy.number } });
    if (!target) entries.set(identity(change.replacedBy), { repository: change.replacedBy.repository,
      number: change.replacedBy.number, kind: 'delivery' });
  }
  const scope = { ...current.scope, version: current.scope.version + 1, entries: [...entries.values()] };
  // This also forbids superseding an existing replacement into a chain.
  if (!reconcileJiraPrScope(scope, { issueKey: scope.issueKey, complete: true, stale: false,
    pullRequests: scope.entries }).complete) throw failure();
  return scope;
}

/** Bind both ends to the exact authenticated inventory; semantic coverage stays an owner decision. */
export function assertJiraScopeRevisionHeads(proof, inventory) {
  const decision = parseJiraScopeDecision(normalizeJiraScopeDecision(proof).decisionText);
  for (const change of decision.supersessions) {
    for (const expected of [change, change.replacedBy]) {
      const found = inventory.pullRequests.filter(pr => identity(pr) === identity(expected));
      if (found.length !== 1 || found[0].headSha !== expected.headSha) throw failure();
    }
  }
}
