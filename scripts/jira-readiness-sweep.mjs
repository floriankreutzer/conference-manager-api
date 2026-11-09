import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadJiraWriterDatabaseConfig, assertJiraWriterIdentity } from './jira-register-publish.mjs';
import { loadJiraReadinessIntegration, normalizeJiraHistoryObservation, reconcileJiraReadinessIssue } from './jira-readiness-write.mjs';
import { collectJiraReadinessCandidates } from './jira-readiness-candidates.mjs';
import { selectJiraReadinessBatch } from './jira-readiness-queue.mjs';

const failure = () => new Error('JIRA_READINESS_SWEEP_UNVERIFIED');
const outcomes = new Set(['JIRA_READINESS_REGISTER_PENDING', 'JIRA_READINESS_TRANSITION_PENDING',
  'JIRA_READINESS_TRANSITION_CONFIRMED', 'JIRA_READINESS_ALREADY_CONFIRMED',
  'JIRA_READINESS_ISSUE_NOT_IN_REVIEW', 'JIRA_READINESS_GATES_BLOCKED']);
export function loadJiraSweepConfig(env = {}) {
  try {
    if (env.GITHUB_REPOSITORY !== 'floriankreutzer/conference-manager-api' || env.GITHUB_REF !== 'refs/heads/main'
      || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      || env.CM_JIRA_TRANSITION_WRITER_ENABLED !== 'true' || env.CM_JIRA_READINESS_AUTOMATION_ENABLED !== 'true') throw failure();
    return { database: loadJiraWriterDatabaseConfig(env), integration: loadJiraReadinessIntegration(env) };
  } catch { throw failure(); }
}

export async function runJiraReadinessSweep({ env = process.env, write = console.log, fetchImpl = fetch,
  poolFactory = config => new Pool(config), discover = collectJiraReadinessCandidates,
  select = selectJiraReadinessBatch, execute = reconcileJiraReadinessIssue } = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 720000);
  let pool; let failed = false; let connectionLost = false; let report;
  const active = () => { if (connectionLost || controller.signal.aborted) throw failure(); };
  try {
    const config = loadJiraSweepConfig(env); pool = poolFactory(config.database);
    pool.on('error', () => { failed = true; connectionLost = true; controller.abort(); });
    await assertJiraWriterIdentity(pool); active();
    const integration = { ...config.integration, pool, deferConfirmation: false, fetchImpl: (url, request) => {
      active(); return fetchImpl(url, { ...request, signal: AbortSignal.any([controller.signal, request.signal]) });
    } };
    const candidates = await discover(integration); active();
    const batch = await select({ pool, cloudId: integration.cloudId, candidates }); active();
    if (!Array.isArray(batch?.issueKeys) || batch.issueKeys.length > 5
      || batch.issueKeys.some(value => typeof value !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(value))
      || new Set(batch.issueKeys).size !== batch.issueKeys.length
      || !Number.isSafeInteger(batch.queueSize) || batch.queueSize < batch.issueKeys.length || batch.queueSize > 1000) throw failure();
    const receipts = [];
    for (const issueKey of batch.issueKeys) {
      active();
      let historyObservation;
      let failurePhase = 'reconciliation';
      let receipt;
      try {
        const result = await execute({ ...integration, issueKey,
          onReadinessPhase: value => {
            if (!['register', 'promotion'].includes(value)) { failurePhase = 'diagnostic'; throw failure(); }
            failurePhase = value;
          },
          onHistoryObservation: value => {
            historyObservation = undefined;
            try { historyObservation = normalizeJiraHistoryObservation(value); }
            catch { failurePhase = 'diagnostic'; throw failure(); }
          } }); active();
        failurePhase = 'receipt';
        if (!outcomes.has(result?.result) || ['transitionSubmitted', 'transitionConfirmed', 'atTarget']
          .some(key => typeof result[key] !== 'boolean')) throw failure();
        receipt = { issueKey, result: result.result, transitionSubmitted: result.transitionSubmitted,
          transitionConfirmed: result.transitionConfirmed, atTarget: result.atTarget };
      } catch {
        failed = true;
        // A failing issue cannot prevent other selected issues from making progress.
        // No false no-write claim: this record deliberately has no transition booleans.
        receipt = { issueKey, result: 'JIRA_READINESS_RUN_UNVERIFIED', failurePhase };
        active();
      }
      if (historyObservation) receipt.historyObservation = historyObservation;
      receipts.push(receipt);
    }
    report = { result: failed ? 'JIRA_READINESS_SWEEP_PARTIAL' : 'JIRA_READINESS_SWEEP_COMPLETED',
      queueSize: batch.queueSize, selected: batch.issueKeys.length, receipts };
  } catch { failed = true; report = { result: 'JIRA_READINESS_SWEEP_UNVERIFIED' }; }
  finally {
    controller.abort(); clearTimeout(timer);
    try { await pool?.end(); } catch { failed = true; report = { result: 'JIRA_READINESS_SWEEP_UNVERIFIED' }; }
    if (connectionLost) report = { result: 'JIRA_READINESS_SWEEP_UNVERIFIED' };
  }
  try { write(JSON.stringify(report)); } catch { return 1; }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.length === 2 ? await runJiraReadinessSweep() : 1;
}
