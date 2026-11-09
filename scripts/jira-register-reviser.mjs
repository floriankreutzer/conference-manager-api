import { readJiraRegister } from './jira-register-reader.mjs';
import { collectGithubPrInventory } from './jira-github-inventory.mjs';
import { proposeJiraPrRegister } from './jira-pr-register.mjs';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from './jira-register-journal.mjs';
import { startJiraRegisterWrite, observeJiraRegisterWrite } from './jira-register-write-transport.mjs';
import { withJiraIssueLock } from './jira-issue-lock.mjs';
import { createPostgresJiraTransitionJournal } from './jira-transition-journal.mjs';
import { readJiraScopeDecision, readJiraScopeWriter } from './jira-scope-decision-reader.mjs';
import { assertJiraScopeRevisionHeads, normalizeJiraScopeExecution } from './jira-register-scope-revision.mjs';

const failure = () => new Error('JIRA_SCOPE_REVISION_PUBLISH_UNVERIFIED');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timeless = ({ startedAt: _start, collectedAt: _end, ...value }) => value;
const outcome = (result, writeSubmitted) => Object.freeze({ result, writeSubmitted, readinessAuthorized: false });

/** Separate manual composition. It cannot enroll, append silently, downgrade a gate or transition an issue. */
async function reviseLocked({ cloudId, issueKey, actorId, email, token, githubToken, commentId,
  expectedDecisionDigest, execution: suppliedExecution, pool, fetchImpl = fetch } = {}) {
  const execution = normalizeJiraScopeExecution(suppliedExecution);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  let requests = 0;
  let bytes = 0;
  const transport = async (url, options) => {
    if (controller.signal.aborted || ++requests > 128) throw failure();
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
    if (response.redirected) { await response.body?.cancel(); throw failure(); }
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, stream) {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024 * 1024 || controller.signal.aborted) throw failure();
      stream.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const jiraOptions = { cloudId, issueKey, actorId, email, token, fetchImpl: transport };
  const decisionOptions = { ...jiraOptions, commentId, expectedDecisionDigest };
  const githubOptions = { token: githubToken, fetchImpl: transport };
  const journal = createPostgresJiraRegisterJournal(pool);
  try {
    await readJiraScopeWriter(jiraOptions);
    const jira = await readJiraRegister(jiraOptions);
    const binding = { cloudId, issueKey, issueId: jira.issueId };
    const current = await journal.read(binding);
    const revision = await journal.readScopeRevision({ ...binding, commentId, expectedDecisionDigest, actorId });
    if (controller.signal.aborted) throw failure();
    const recover = async (pending, writeSubmitted) => {
      if (controller.signal.aborted) throw failure();
      const receipt = await journal.readWriteReceipt({ ...binding, digest: pending.digest });
      if (receipt.taskId === null || controller.signal.aborted) throw failure();
      const observation = await observeJiraRegisterWrite({ ...jiraOptions, issueId: jira.issueId,
        taskId: receipt.taskId, expectedScope: pending.scope });
      if (!observation.completed) return outcome('JIRA_SCOPE_REVISION_TASK_PENDING', writeSubmitted);
      if (controller.signal.aborted) throw failure();
      await journal.confirm({ ...binding, observedScope: observation.scope });
      if (controller.signal.aborted) throw failure();
      return outcome('JIRA_SCOPE_REVISION_CONFIRMED', writeSubmitted);
    };
    if (revision?.state === 'pending') {
      if (current?.digest !== revision.digest) throw failure();
      // Observe only this decision's original task, even after a status change or comment deletion.
      return await recover(revision, false);
    }
    if (!current || current.state !== 'confirmed' || !jira.scope
      || canonicalJiraRegister(jira.scope).digest !== current.digest) throw failure();
    if (revision) return outcome('JIRA_SCOPE_REVISION_ALREADY_CONFIRMED', false);
    if (jira.issueStatus !== 'in Review') return outcome('JIRA_SCOPE_REVISION_ISSUE_NOT_IN_REVIEW', false);
    if (await createPostgresJiraTransitionJournal(pool).pending(binding)) throw failure();
    const decision = await readJiraScopeDecision(decisionOptions);
    const inventory = await collectGithubPrInventory(githubOptions);
    // First reconcile every newly discovered obligation through the existing append path.
    if (proposeJiraPrRegister({ issueKey, previous: current.scope, inventory }).changed) throw failure();
    assertJiraScopeRevisionHeads(decision, inventory);
    const [finalJira, finalInventory, finalDecision] = await Promise.all([
      readJiraRegister(jiraOptions), collectGithubPrInventory(githubOptions), readJiraScopeDecision(decisionOptions),
    ]);
    if (!same(jira, finalJira) || !same(timeless(inventory), timeless(finalInventory))
      || !same(decision, finalDecision) || controller.signal.aborted) throw failure();
    const prepared = await journal.prepareScopeRevision({ ...binding, decision, execution });
    if (controller.signal.aborted) throw failure();
    if (prepared.writeClaimed !== true) throw failure(); // No new write for a duplicate/uncertain commit.
    const receipt = await startJiraRegisterWrite({ ...jiraOptions, issueId: jira.issueId,
      expectedScope: current.scope, nextScope: prepared.scope });
    if (controller.signal.aborted) throw failure();
    await journal.attachWriteReceipt({ ...binding, digest: prepared.digest, taskId: receipt.taskId });
    return await recover(prepared, true);
  } catch { throw failure(); }
  finally { controller.abort(); clearTimeout(timer); }
}

export async function reviseJiraRegisterScope(options = {}) {
  try {
    return await withJiraIssueLock(options, lease => reviseLocked({ ...options, pool: lease.pool,
      fetchImpl: (url, request) => {
        lease.assertActive();
        return (options.fetchImpl ?? fetch)(url, { ...request,
          signal: AbortSignal.any([lease.signal, request.signal]) });
      } }));
  } catch { throw failure(); }
}
