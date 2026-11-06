import { pathToFileURL } from 'node:url';
import { collectGithubPrGates } from './jira-github-gates.mjs';

export async function runGatesDiagnostic({ write = console.log, ...options } = {}) {
  try {
    const evidence = await collectGithubPrGates(options);
    write(JSON.stringify({ schemaVersion: 1, result: 'GITHUB_PR_GATES_READ',
      requiredChecks: evidence.requiredChecks.length,
      allRequiredChecksSuccessful: evidence.checks.every((check) => check.status === 'completed' && check.conclusion === 'success'),
      merged: evidence.merged, draft: evidence.draft, unresolvedThreads: evidence.unresolvedThreads,
      unresolvedFindings: evidence.unresolvedFindings, changesRequested: evidence.changesRequested,
      readinessEvaluated: false, mutationPerformed: false }));
    return 0;
  } catch {
    write(JSON.stringify({ schemaVersion: 1, result: 'GITHUB_PR_GATES_UNVERIFIED',
      readinessEvaluated: false, mutationPerformed: false }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.env.CM_GITHUB_PR_NUMBER;
  process.exitCode = await runGatesDiagnostic({ token: process.env.CM_GITHUB_GATES_TOKEN,
    repository: process.env.CM_GITHUB_PR_REPOSITORY,
    number: typeof input === 'string' && /^[1-9][0-9]{0,9}$/.test(input) ? Number(input) : null });
}
