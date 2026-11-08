import { readJiraRegister } from './jira-register-reader.mjs';
import { collectGithubPrInventory } from './jira-github-inventory.mjs';
import { proposeJiraPrRegister } from './jira-pr-register.mjs';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from './jira-register-journal.mjs';
import { startJiraRegisterWrite, observeJiraRegisterWrite } from './jira-register-write-transport.mjs';
import { withJiraIssueLock } from './jira-issue-lock.mjs';

const failure = () => new Error('JIRA_REGISTER_PUBLISH_UNVERIFIED');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const timeless = ({ startedAt: _start, collectedAt: _end, ...value }) => value;
const digest = scope => scope === null ? null : canonicalJiraRegister(scope).digest;
const outcome = (result, writeSubmitted) => Object.freeze({ result, writeSubmitted, readinessAuthorized: false });

/**
 * Trusted integration composition. Pool is a bounded, TLS-verified, isolated
 * operator pool, never application/customer credentials. No CLI or trigger.
 */
async function publishLockedRegister({ cloudId, email, token, githubToken, issueKey, pool, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  let requests = 0;
  let bytes = 0;
  const transport = async (url, options) => {
    if (controller.signal.aborted || ++requests > 128) throw failure();
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.any([controller.signal, options.signal]) });
    if (response.redirected) {
      await response.body?.cancel();
      throw failure();
    }
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream({ transform(chunk, stream) {
      bytes += chunk.byteLength;
      if (bytes > 32 * 1024 * 1024 || controller.signal.aborted) throw failure();
      stream.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, headers: response.headers });
  };
  const jiraOptions = { cloudId, email, token, issueKey, fetchImpl: transport };
  const githubOptions = { token: githubToken, fetchImpl: transport };
  const journal = createPostgresJiraRegisterJournal(pool);
  try {
    const jira = await readJiraRegister(jiraOptions);
    const binding = { cloudId, issueKey, issueId: jira.issueId };
    const current = await journal.read(binding);
    if (controller.signal.aborted) throw failure();
    const recover = async (pending, writeSubmitted) => {
      if (controller.signal.aborted) throw failure();
      const receipt = await journal.readWriteReceipt({ ...binding, digest: pending.digest });
      if (receipt.taskId === null || controller.signal.aborted) throw failure(); // Quarantine unknown dispatch; never replay.
      const observation = await observeJiraRegisterWrite({ ...jiraOptions, issueId: jira.issueId,
        taskId: receipt.taskId, expectedScope: pending.scope });
      if (!observation.completed) return outcome('JIRA_REGISTER_TASK_PENDING', writeSubmitted);
      if (controller.signal.aborted) throw failure();
      await journal.confirm({ ...binding, observedScope: observation.scope });
      if (controller.signal.aborted) throw failure();
      return outcome('JIRA_REGISTER_CONFIRMED', writeSubmitted);
    };
    if (current?.state === 'pending') return await recover(current, false);
    if (digest(jira.scope) !== (current?.digest ?? null)) throw failure();
    if (jira.issueStatus !== 'in Review') return outcome('JIRA_REGISTER_ISSUE_NOT_IN_REVIEW', false);
    const inventory = await collectGithubPrInventory(githubOptions);
    const proposal = proposeJiraPrRegister({ issueKey, previous: current?.scope ?? null, inventory });
    const [finalJira, finalInventory] = await Promise.all([
      readJiraRegister(jiraOptions), collectGithubPrInventory(githubOptions),
    ]);
    if (!same(jira, finalJira) || !same(timeless(inventory), timeless(finalInventory))
      || controller.signal.aborted) throw failure();
    if (!proposal.changed) return outcome('JIRA_REGISTER_UNCHANGED', false);
    const prepared = await journal.prepare({ ...binding, scope: proposal.scope,
      expectedDigest: current?.digest ?? null, claimWrite: true });
    if (controller.signal.aborted) throw failure();
    if (prepared.writeClaimed !== true) return await recover(prepared, false);
    // Only this freshly committed claim can submit one conditional provider task.
    const receipt = await startJiraRegisterWrite({ ...jiraOptions, issueId: jira.issueId,
      expectedScope: current?.scope ?? null, nextScope: prepared.scope });
    if (controller.signal.aborted) throw failure();
    await journal.attachWriteReceipt({ ...binding, digest: prepared.digest, taskId: receipt.taskId });
    return await recover(prepared, true);
  } catch {
    // The failure intentionally does not assert writeSubmitted=false. Pending
    // intents/receipts, not an error or timeout, determine later recovery actions.
    throw failure();
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

export async function publishJiraRegister(options = {}) {
  try {
    return await withJiraIssueLock(options, lease => publishLockedRegister({ ...options, pool: lease.pool,
      fetchImpl: (url, request) => {
        lease.assertActive();
        return (options.fetchImpl ?? fetch)(url, { ...request,
          signal: AbortSignal.any([lease.signal, request.signal]) });
      } }));
  } catch { throw failure(); }
}
