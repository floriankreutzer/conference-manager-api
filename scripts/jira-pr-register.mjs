import { reconcileJiraPrScope } from './jira-pr-scope.mjs';

const REPOSITORIES = ['floriankreutzer/conference-manager', 'floriankreutzer/conference-manager-api'];
const identity = (pr) => `${pr.repository}#${pr.number}`;
const fail = () => { throw new Error('JIRA_PR_REGISTER_UNVERIFIED'); };
const dense = (value, maximum) => Array.isArray(value) && value.length <= maximum
  && Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean);
const association = (scope) => ({ issueKey: scope.issueKey, complete: true, stale: false, pullRequests: scope.entries });

/**
 * Pure register proposal. Previous state must be authenticated by the persistence
 * adapter. Neither this proposal nor caller-supplied inventory flags authorize a write.
 */
export function proposeJiraPrRegister({ issueKey, previous = null, inventory, now = Date.now() } = {}) {
  if (typeof issueKey !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(issueKey)
    || !Number.isSafeInteger(now) || now < 0 || !inventory
    || !Number.isSafeInteger(inventory.startedAt) || !Number.isSafeInteger(inventory.collectedAt)
    || inventory.startedAt < 0 || inventory.startedAt > inventory.collectedAt
    || inventory.collectedAt > now || now - inventory.startedAt > 60000
    || !dense(inventory.inventories, 2) || inventory.inventories.length !== 2
    || !dense(inventory.pullRequests, 2000)) fail();
  const all = new Map();
  for (const pr of inventory.pullRequests) {
    if (!pr || !REPOSITORIES.includes(pr.repository) || !Number.isSafeInteger(pr.number) || pr.number <= 0
      || typeof pr.title !== 'string' || pr.title.length > 1024
      || typeof pr.headRef !== 'string' || pr.headRef.length > 1024
      || all.has(identity(pr))) fail();
    all.set(identity(pr), pr);
  }
  for (const repository of REPOSITORIES) {
    const sources = inventory.inventories.filter((source) => source?.repository === repository);
    const count = inventory.pullRequests.filter((pr) => pr.repository === repository).length;
    if (sources.length !== 1 || count > 1000) fail();
    const source = sources[0];
    if (source.authenticated !== true || source.complete !== true || source.nextPage !== null
      || source.incompleteResults !== false || source.count !== count || source.returnedCount !== count) fail();
  }
  if (previous !== null && (previous.issueKey !== issueKey
    || !reconcileJiraPrScope(previous, association(previous)).complete)) fail();
  const entries = new Map((previous?.entries ?? []).map((entry) => [identity(entry), structuredClone(entry)]));
  // A removed/renamed key never removes an existing obligation. Missing provider
  // records block instead of silently shrinking scope. Exceptions remain explicit.
  for (const entry of entries.values()) {
    if (REPOSITORIES.includes(entry.repository) && !all.has(identity(entry))) fail();
  }
  const keyPattern = new RegExp(`(^|[^A-Za-z0-9])${issueKey}(?=$|[^A-Za-z0-9])`);
  for (const pr of all.values()) {
    if ((keyPattern.test(pr.title) || keyPattern.test(pr.headRef)) && !entries.has(identity(pr))) {
      entries.set(identity(pr), { repository: pr.repository, number: pr.number, kind: 'delivery' });
    }
  }
  if (entries.size === 0 || entries.size > 1000) fail();
  const changed = previous === null || entries.size !== previous.entries.length;
  const version = previous === null ? 1 : previous.version + (changed ? 1 : 0);
  if (!Number.isSafeInteger(version)) fail();
  const scope = { schemaVersion: 1, issueKey, version, closed: true,
    entries: [...entries.values()].sort((a, b) => identity(a).localeCompare(identity(b))) };
  const reconciled = reconcileJiraPrScope(scope, association(scope));
  if (!reconciled.complete) fail();
  return { changed, scope, scopeRevision: reconciled.scopeRevision,
    expectedPullRequests: reconciled.expectedPullRequests };
}
