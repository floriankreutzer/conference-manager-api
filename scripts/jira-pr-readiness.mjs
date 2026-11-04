import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{40}$/;
const KEY = /^CO-[1-9][0-9]{0,8}$/;
const REPOSITORIES = Object.freeze([
  'floriankreutzer/conference-manager',
  'floriankreutzer/conference-manager-api',
]);
const MAX_PRS = 1000;
const MAX_AGE_MS = 60000;

function reject(reason) {
  return Object.freeze({ eligible: false, reason });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedList(value, limit) {
  return Array.isArray(value) && value.length <= limit
    && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);
}

function validSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

function validReference(pr) {
  return object(pr) && REPOSITORIES.includes(pr.repository)
    && Number.isSafeInteger(pr.number) && pr.number > 0;
}

function identity(pr) {
  return `${pr.repository}#${pr.number}`;
}

function completeInventory(inventories) {
  if (!boundedList(inventories, REPOSITORIES.length) || inventories.length !== REPOSITORIES.length) return false;
  return REPOSITORIES.every((repository) => {
    const entries = inventories.filter((item) => object(item) && item.repository === repository);
    if (entries.length !== 1) return false;
    const item = entries[0];
    return item.authenticated === true && item.complete === true && item.nextPage === null
      && item.incompleteResults === false && Number.isSafeInteger(item.count) && item.count >= 0
      && item.count <= MAX_PRS && item.count === item.returnedCount;
  });
}

function checksPass(pr) {
  if (!validSha(pr.headSha) || !validSha(pr.mergeSha) || pr.checksHeadSha !== pr.headSha) return false;
  if (!boundedList(pr.requiredChecks, 100) || pr.requiredChecks.length === 0) return false;
  if (!boundedList(pr.checks, 100) || pr.checksComplete !== true) return false;
  const names = new Set();
  for (const required of pr.requiredChecks) {
    if (!object(required) || typeof required.name !== 'string' || required.name.length === 0
      || required.name.length > 200 || !Number.isSafeInteger(required.appId) || required.appId <= 0) return false;
    const key = `${required.appId}:${required.name}`;
    if (names.has(key)) return false;
    names.add(key);
    const matches = pr.checks.filter((check) => object(check)
      && check.name === required.name && check.appId === required.appId);
    if (matches.length !== 1) return false;
    const check = matches[0];
    if (check.headSha !== pr.headSha || check.status !== 'completed' || check.conclusion !== 'success') return false;
  }
  return true;
}

function reviewPasses(pr) {
  return pr.policyComplete === true && validSha(pr.policyRevision)
    && pr.reviewsComplete === true && pr.reviewHeadSha === pr.headSha
    && pr.unresolvedThreads === 0 && pr.unresolvedFindings === 0
    && pr.reviewCompleted === true && pr.changesRequested === false
    && Number.isSafeInteger(pr.requiredApprovals) && pr.requiredApprovals >= 0
    && Number.isSafeInteger(pr.validApprovals) && pr.validApprovals >= pr.requiredApprovals;
}

/**
 * Pure decision kernel for a trusted collector, not a public endpoint or an attestation verifier.
 * No caller-provided snapshot may authorize a Jira transition without independent collection,
 * authentication, freshness, exact scope binding and a serialized final recheck by the adapter.
 */
export function evaluateJiraPrReadiness(snapshot, { now = Date.now() } = {}) {
  if (!object(snapshot) || snapshot.schemaVersion !== 1 || typeof snapshot.issueKey !== 'string' || !KEY.test(snapshot.issueKey)
    || !Number.isSafeInteger(now) || now < 0) return reject('INVALID_SNAPSHOT');
  if (snapshot.issueStatus !== 'in Review') return reject('ISSUE_NOT_IN_REVIEW');
  if (!Number.isSafeInteger(snapshot.collectedAt) || !Number.isSafeInteger(snapshot.startedAt)
    || snapshot.startedAt > snapshot.collectedAt || snapshot.collectedAt > now
    || now - snapshot.startedAt > MAX_AGE_MS) return reject('STALE_OR_INVALID_OBSERVATION');
  if (!validSha(snapshot.scopeRevision) || snapshot.scopeClosed !== true
    || snapshot.associationComplete !== true || snapshot.indexConsistent !== true) return reject('INCOMPLETE_SCOPE');
  if (!completeInventory(snapshot.inventories)) return reject('INCOMPLETE_INVENTORY');
  if (!boundedList(snapshot.expectedPullRequests, MAX_PRS) || snapshot.expectedPullRequests.length === 0
    || !boundedList(snapshot.pullRequests, MAX_PRS)) return reject('INVALID_PR_SET');
  const expected = snapshot.expectedPullRequests;
  const actual = snapshot.pullRequests;
  if (!expected.every(validReference) || !actual.every(validReference)) return reject('INVALID_PR_REFERENCE');
  if (snapshot.inventories.some((item) => actual.filter((pr) => pr.repository === item.repository).length > item.count)) {
    return reject('INCONSISTENT_INVENTORY');
  }
  const expectedIds = expected.map(identity).sort();
  const actualIds = actual.map(identity).sort();
  if (new Set(expectedIds).size !== expectedIds.length || new Set(actualIds).size !== actualIds.length
    || expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    return reject('PR_SET_MISMATCH');
  }
  for (const pr of actual) {
    if (pr.issueKey !== snapshot.issueKey || pr.draft !== false || pr.state !== 'closed' || pr.merged !== true
      || !Number.isSafeInteger(pr.mergedAt) || pr.mergedAt < 0 || pr.mergedAt > snapshot.collectedAt) {
      return reject('UNMERGED_OR_UNKNOWN_PR');
    }
    if (!checksPass(pr)) return reject('CHECKS_NOT_VERIFIED');
    if (!reviewPasses(pr)) return reject('REVIEW_NOT_VERIFIED');
  }
  const boundPrs = [...actual].sort((a, b) => identity(a).localeCompare(identity(b))).map((pr) => ({
    repository: pr.repository, number: pr.number, headSha: pr.headSha, mergeSha: pr.mergeSha,
    policyRevision: pr.policyRevision,
  }));
  const decisionKey = createHash('sha256').update(JSON.stringify({
    issueKey: snapshot.issueKey, scopeRevision: snapshot.scopeRevision, pullRequests: boundPrs,
  })).digest('hex');
  return Object.freeze({ eligible: true, targetStatus: 'Ready for Deployment', decisionKey });
}
