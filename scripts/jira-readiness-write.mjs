import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadJiraWriterDatabaseConfig, assertJiraWriterIdentity } from './jira-register-publish.mjs';
import { publishJiraRegister } from './jira-register-publisher.mjs';
import { promoteJiraReadiness } from './jira-readiness-promoter.mjs';

const failure = () => new Error('JIRA_READINESS_RUN_UNVERIFIED');
const results = new Set(['JIRA_READINESS_TRANSITION_PENDING', 'JIRA_READINESS_TRANSITION_CONFIRMED',
  'JIRA_READINESS_ALREADY_CONFIRMED', 'JIRA_READINESS_ISSUE_NOT_IN_REVIEW', 'JIRA_READINESS_GATES_BLOCKED']);

export function loadJiraReadinessIntegration(env = {}) {
  if (typeof env.CM_JIRA_WRITER_ACCOUNT_ID !== 'string'
    || !/^[a-zA-Z0-9:-]{1,128}$/.test(env.CM_JIRA_WRITER_ACCOUNT_ID)) throw failure();
  return { cloudId: env.CM_JIRA_CLOUD_ID, email: env.CM_JIRA_WRITER_EMAIL, token: env.CM_JIRA_WRITER_API_TOKEN,
    githubToken: env.CM_GITHUB_GATES_TOKEN, actorId: env.CM_JIRA_WRITER_ACCOUNT_ID };
}

export function loadJiraReadinessConfig(env = {}) {
  try {
    if (env.GITHUB_REPOSITORY !== 'floriankreutzer/conference-manager-api'
      || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.CM_JIRA_TRANSITION_WRITER_ENABLED !== 'true'
      || typeof env.CM_JIRA_ISSUE_KEY !== 'string' || !/^CO-[1-9][0-9]{0,8}$/.test(env.CM_JIRA_ISSUE_KEY)
      || !['true', 'false'].includes(env.CM_JIRA_DEFER_CONFIRMATION ?? 'false')) throw failure();
    return { database: loadJiraWriterDatabaseConfig(env), integration: { ...loadJiraReadinessIntegration(env),
      issueKey: env.CM_JIRA_ISSUE_KEY, deferConfirmation: env.CM_JIRA_DEFER_CONFIRMATION === 'true' } };
  } catch { throw failure(); }
}

/** Shared trusted composition; callers establish their actual event, environment and identity before invoking it. */
export async function reconcileJiraReadinessIssue(options, { publish = publishJiraRegister, promote = promoteJiraReadiness } = {}) {
  const registered = await publish(options);
  if (!['JIRA_REGISTER_CONFIRMED', 'JIRA_REGISTER_UNCHANGED', 'JIRA_REGISTER_TASK_PENDING',
    'JIRA_REGISTER_ISSUE_NOT_IN_REVIEW'].includes(registered?.result) || registered.readinessAuthorized !== false) throw failure();
  if (registered.result === 'JIRA_REGISTER_TASK_PENDING') {
    return { result: 'JIRA_READINESS_REGISTER_PENDING', transitionSubmitted: false, transitionConfirmed: false, atTarget: false };
  }
  const result = await promote(options);
  if (!results.has(result?.result) || ['transitionSubmitted', 'transitionConfirmed', 'atTarget']
    .some(key => typeof result[key] !== 'boolean')) throw failure();
  return { result: result.result, transitionSubmitted: result.transitionSubmitted,
    transitionConfirmed: result.transitionConfirmed, atTarget: result.atTarget };
}

export async function runJiraReadiness({ env = process.env, write = console.log,
  poolFactory = config => new Pool(config), publish = publishJiraRegister,
  promote = promoteJiraReadiness, fetchImpl = fetch } = {}) {
  let pool;
  let failed = false;
  let report;
  const controller = new AbortController();
  try {
    const config = loadJiraReadinessConfig(env);
    pool = poolFactory(config.database);
    pool.on('error', () => { failed = true; controller.abort(); });
    await assertJiraWriterIdentity(pool);
    if (failed) throw failure();
    const options = { ...config.integration, pool, fetchImpl: (url, request) => {
      if (failed || controller.signal.aborted) throw failure();
      return fetchImpl(url, { ...request, signal: AbortSignal.any([controller.signal, request.signal]) });
    } };
    report = await reconcileJiraReadinessIssue(options, { publish, promote });
    if (failed) throw failure();
  } catch { failed = true; }
  finally {
    controller.abort();
    try { await pool?.end(); } catch { failed = true; }
  }
  if (failed) report = { result: 'JIRA_READINESS_RUN_UNVERIFIED' };
  // Errors never assert that an external write did not happen.
  try { write(JSON.stringify(report)); } catch { return 1; }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.length === 2 ? await runJiraReadiness() : 1;
}
