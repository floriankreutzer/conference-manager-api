import { withJiraIssueLock } from './jira-issue-lock.mjs';
import { readJiraRegister } from './jira-register-reader.mjs';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from './jira-register-journal.mjs';
import { createPostgresJiraTransitionJournal } from './jira-transition-journal.mjs';
import { collectJiraReadinessSnapshot } from './jira-readiness-collection.mjs';
import { evaluateJiraPrReadiness } from './jira-pr-readiness.mjs';
import { readJiraReadyTransition, submitJiraReadyTransition, observeJiraReadyTransition } from './jira-transition-transport.mjs';

const failure = () => new Error('JIRA_READINESS_PROMOTION_UNVERIFIED');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const outcome = (result, transitionSubmitted = false, transitionConfirmed = false, atTarget = false) =>
  Object.freeze({ result, transitionSubmitted, transitionConfirmed, atTarget });

/** No snapshots enter this entry point. It collects the owning sources under an
 * issue lock, verifies journal provenance, commits one claim and submits once.
 * Recovery only observes the original attempt; it never repeats a transition.
 */
export async function promoteJiraReadiness(options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  const startedAt = Date.now();
  let requests = 0;
  let bytes = 0;
  try {
    if (typeof options.actorId !== 'string' || !/^[a-zA-Z0-9:-]{1,128}$/.test(options.actorId)
      || (options.deferConfirmation !== undefined && typeof options.deferConfirmation !== 'boolean')) throw failure();
    return await withJiraIssueLock({ ...options, signal: controller.signal }, async lease => {
      const transport = async (url, request) => {
        lease.assertActive();
        if (++requests > 600 || Date.now() - startedAt > 90000) throw failure();
        const response = await (options.fetchImpl ?? fetch)(url, { ...request,
          signal: AbortSignal.any([lease.signal, request.signal]) });
        if (response.redirected) { await response.body?.cancel(); throw failure(); }
        if (!response.body) return response;
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, stream) {
          bytes += chunk.byteLength;
          lease.assertActive();
          if (bytes > 72 * 1024 * 1024) throw failure();
          stream.enqueue(chunk);
        } })), { status: response.status, headers: response.headers });
      };
      const provider = { ...options, fetchImpl: transport };
      const initial = await readJiraRegister(provider);
      const binding = { cloudId: options.cloudId, issueKey: options.issueKey, issueId: initial.issueId };
      const register = createPostgresJiraRegisterJournal(lease.pool);
      const journal = createPostgresJiraTransitionJournal(lease.pool);
      const recover = async (attempt, submitted) => {
        lease.assertActive();
        const receipt = await observeJiraReadyTransition({ ...provider, ...binding, attempt });
        if (!receipt.completed) return outcome('JIRA_READINESS_TRANSITION_PENDING', submitted);
        lease.assertActive();
        await journal.confirm({ ...binding, decisionKey: attempt.decisionKey,
          attemptId: attempt.attemptId, historyId: receipt.historyId });
        lease.assertActive();
        return outcome('JIRA_READINESS_TRANSITION_CONFIRMED', submitted, true, receipt.atTarget);
      };
      const pending = await journal.pending(binding);
      if (pending) return recover(pending, false);
      if (initial.issueStatus !== 'in Review') return outcome('JIRA_READINESS_ISSUE_NOT_IN_REVIEW');
      const current = await register.read(binding);
      if (!current || current.state !== 'confirmed' || initial.scope === null
        || canonicalJiraRegister(initial.scope).digest !== current.digest) throw failure();
      const firstTransition = await readJiraReadyTransition({ ...provider, ...binding });
      if (!same(initial, firstTransition.jira)) throw failure();
      const collected = await collectJiraReadinessSnapshot(provider);
      if (!same(initial, collected.jira) || collected.proposal.changed
        || canonicalJiraRegister(collected.proposal.scope).digest !== current.digest) throw failure();
      if (!collected.candidate.eligible) return outcome('JIRA_READINESS_GATES_BLOCKED');
      const lastTransition = await readJiraReadyTransition({ ...provider, ...binding });
      if (!same(firstTransition, lastTransition)) throw failure();
      const anchored = await register.read(binding);
      if (anchored?.state !== 'confirmed' || anchored.digest !== current.digest) throw failure();
      const decision = evaluateJiraPrReadiness(collected.snapshot);
      if (!decision.eligible || !same(decision, collected.candidate)) throw failure();
      lease.assertActive();
      const claimed = await journal.claim({ ...binding, decision: { decisionKey: decision.decisionKey,
        registerVersion: current.scope.version, registerDigest: current.digest, actorId: options.actorId,
        transitionId: lastTransition.transitionId, sourceStatusId: lastTransition.sourceStatusId,
        targetStatusId: lastTransition.targetStatusId, issueUpdatedAt: lastTransition.issueUpdatedAt } });
      lease.assertActive();
      if (!claimed.claimed) {
        return claimed.attempt.state === 'pending' ? recover(claimed.attempt, false)
          : outcome('JIRA_READINESS_ALREADY_CONFIRMED', false, true);
      }
      // A slow/uncertain database commit cannot prolong the validity of old gates.
      if (!evaluateJiraPrReadiness(collected.snapshot).eligible) throw failure();
      await submitJiraReadyTransition({ ...provider, ...binding, attempt: claimed.attempt });
      // Controlled restart qualification. A later invocation only observes the
      // original history receipt, including when Jira has already left in Review.
      if (options.deferConfirmation === true) return outcome('JIRA_READINESS_TRANSITION_PENDING', true);
      return recover(claimed.attempt, true);
    });
  } catch { throw failure(); }
  finally { controller.abort(); clearTimeout(timer); }
}
