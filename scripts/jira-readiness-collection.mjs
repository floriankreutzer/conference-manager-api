import { readJiraRegister } from './jira-register-reader.mjs';
import { collectGithubPrInventory } from './jira-github-inventory.mjs';
import { collectGithubPrGates } from './jira-github-gates.mjs';
import { proposeJiraPrRegister } from './jira-pr-register.mjs';
import { evaluateJiraPrReadiness } from './jira-pr-readiness.mjs';

const failure = () => new Error('JIRA_READINESS_COLLECTION_UNVERIFIED');
const identity = (pr) => `${pr.repository}#${pr.number}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timeless = ({ startedAt: _start, collectedAt: _end, ...value }) => value;
const MAX_DELIVERY_PRS = 20;
const MAX_REQUESTS = 512;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 55000;

function boundedTransport(fetchImpl, controller, startedAt) {
  let requests = 0;
  let bytes = 0;
  return async (url, options) => {
    if (++requests > MAX_REQUESTS || controller.signal.aborted || Date.now() - startedAt > MAX_DURATION_MS) throw failure();
    const response = await fetchImpl(url, { ...options,
      signal: AbortSignal.any([controller.signal, options.signal]) });
    if (response.redirected) {
      await response.body?.cancel();
      throw failure();
    }
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, stream) {
        bytes += chunk.byteLength;
        if (bytes > MAX_TOTAL_BYTES) throw failure();
        stream.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, headers: response.headers });
  };
}

async function collectGates(references, inventory, options) {
  if (references.length > MAX_DELIVERY_PRS) throw failure();
  const known = new Map(inventory.pullRequests.map((pr) => [identity(pr), pr]));
  const result = [];
  // Fixed two-request fan-out; never start an unbounded promise per discovered PR.
  for (let offset = 0; offset < references.length; offset += 2) {
    const batch = await Promise.all(references.slice(offset, offset + 2).map(async (reference) => {
      const gates = await collectGithubPrGates({ ...options, ...reference });
      const listed = known.get(identity(reference));
      if (!listed || gates.headSha !== listed.headSha || gates.draft !== listed.draft || gates.state !== listed.state) throw failure();
      return timeless(gates);
    }));
    result.push(...batch);
  }
  return result;
}

/** Two independent read passes. Candidate evaluation is never register provenance or transition authority. */
export async function collectJiraReadinessSnapshot({ cloudId, email, token, githubToken, issueKey, fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_DURATION_MS);
  const transport = boundedTransport(fetchImpl, controller, startedAt);
  const jiraOptions = { cloudId, email, token, issueKey, fetchImpl: transport };
  const githubOptions = { token: githubToken, fetchImpl: transport };
  const readSources = () => Promise.all([readJiraRegister(jiraOptions), collectGithubPrInventory(githubOptions)]);
  try {
    const [jira, inventory] = await readSources();
    const proposal = proposeJiraPrRegister({ issueKey, previous: jira.scope, inventory });
    const gates = await collectGates(proposal.expectedPullRequests, inventory, githubOptions);
    const finalGates = await collectGates(proposal.expectedPullRequests, inventory, githubOptions);
    // End with issue/inventory recollection so changes during either gate pass are covered.
    const [finalJira, finalInventory] = await readSources();
    if (!same(jira, finalJira) || !same(timeless(inventory), timeless(finalInventory))) throw failure();
    // Gate results, policy and reviews must still agree, not only the PR head.
    if (!same(gates, finalGates) || controller.signal.aborted || Date.now() - startedAt > MAX_DURATION_MS) throw failure();
    const snapshot = { schemaVersion: 1, issueKey, issueStatus: finalJira.issueStatus,
      startedAt, collectedAt: Date.now(), scopeRevision: proposal.scopeRevision,
      // These are hypothetical proposal conditions, never assertions of Jira writer authority.
      scopeClosed: true, associationComplete: true, indexConsistent: true,
      inventories: finalInventory.inventories, expectedPullRequests: proposal.expectedPullRequests,
      pullRequests: finalGates.map((pr) => ({ ...pr, issueKey })) };
    // Internal evidence only. The caller must independently verify journal
    // provenance and retain its issue lock before deriving mutation authority.
    return { jira: finalJira, proposal, snapshot, candidate: evaluateJiraPrReadiness(snapshot) };
  } catch {
    throw failure();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

