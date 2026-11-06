import { createHash } from 'node:crypto';

const REPOSITORIES = new Set(['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api']);
const reference = (pr) => pr && typeof pr.repository === 'string'
  && /^[a-zA-Z0-9_.-]{1,100}\/[a-zA-Z0-9_.-]{1,100}$/.test(pr.repository)
  && Number.isSafeInteger(pr.number) && pr.number > 0;
const identity = (pr) => `${pr.repository}#${pr.number}`;
const list = (items) => Array.isArray(items) && items.length <= 1000
  && Array.from({ length: items.length }, (_, i) => Object.hasOwn(items, i)).every(Boolean);
const reject = () => Object.freeze({ complete: false, reason: 'JIRA_PR_SCOPE_UNVERIFIED' });

/** Pure reconciliation only. The adapter must authenticate and authorize the Jira scope source. */
export function reconcileJiraPrScope(scope, association) {
  if (!scope || scope.schemaVersion !== 1 || !/^CO-[1-9][0-9]{0,8}$/.test(scope.issueKey)
    || scope.closed !== true || !Number.isSafeInteger(scope.version) || scope.version < 1
    || !list(scope.entries) || scope.entries.length === 0
    || !association || association.issueKey !== scope.issueKey || association.complete !== true
    || association.stale !== false || !list(association.pullRequests)) return reject();
  const entries = new Map();
  for (const entry of scope.entries) {
    if (!reference(entry) || entries.has(identity(entry))) return reject();
    if (!['delivery', 'supporting', 'superseded'].includes(entry.kind)) return reject();
    if (entry.kind === 'delivery' && !REPOSITORIES.has(entry.repository)) return reject();
    if (entry.kind !== 'delivery' && (typeof entry.reason !== 'string'
      || entry.reason.trim().length === 0 || entry.reason.length > 1000)) return reject();
    entries.set(identity(entry), entry);
  }
  const associated = new Set();
  for (const pr of association.pullRequests) {
    if (!reference(pr) || associated.has(identity(pr)) || !entries.has(identity(pr))) return reject();
    associated.add(identity(pr));
  }
  if (associated.size !== entries.size) return reject();
  const delivery = [];
  for (const entry of entries.values()) {
    if (entry.kind === 'delivery') delivery.push({ repository: entry.repository, number: entry.number });
    if (entry.kind === 'superseded') {
      if (!reference(entry.replacedBy) || entries.get(identity(entry.replacedBy))?.kind !== 'delivery') return reject();
    }
  }
  if (delivery.length === 0) return reject();
  delivery.sort((a, b) => identity(a).localeCompare(identity(b)));
  const normalized = [...entries.values()].sort((a, b) => identity(a).localeCompare(identity(b))).map((entry) => ({
    repository: entry.repository, number: entry.number, kind: entry.kind,
    reason: entry.kind === 'delivery' ? null : entry.reason,
    replacedBy: entry.kind === 'superseded' ? identity(entry.replacedBy) : null,
  }));
  const scopeRevision = createHash('sha1').update(JSON.stringify({
    issueKey: scope.issueKey, version: scope.version, entries: normalized,
  })).digest('hex');
  return Object.freeze({ complete: true, scopeRevision, expectedPullRequests: delivery });
}
