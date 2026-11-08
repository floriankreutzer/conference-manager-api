import { pathToFileURL } from 'node:url';
import { collectJiraReadinessSnapshot } from './jira-readiness-collection.mjs';

const failure = () => new Error('JIRA_READINESS_DIAGNOSTIC_UNVERIFIED');

/** A diagnostic never exposes internal mutation evidence or authorizes readiness. */
export async function diagnoseJiraReadiness(options = {}) {
  try {
    const { jira, proposal, snapshot, candidate } = await collectJiraReadinessSnapshot(options);
    return Object.freeze({ schemaVersion: 1, result: 'JIRA_READINESS_DIAGNOSTIC_READ',
      enrollmentRequired: jira.enrollmentRequired, registerUpdateRequired: proposal.changed,
      deliveryPullRequests: snapshot.pullRequests.length,
      candidateGateResult: candidate.eligible ? 'CANDIDATE_GATES_PASS' : candidate.reason,
      registerProvenanceVerified: false, readinessAuthorized: false, mutationPerformed: false });
  } catch { throw failure(); }
}

export async function runReadinessDiagnostic({ write = console.log, ...options } = {}) {
  try {
    write(JSON.stringify(await diagnoseJiraReadiness(options)));
    return 0;
  } catch {
    write(JSON.stringify({ schemaVersion: 1, result: 'JIRA_READINESS_DIAGNOSTIC_UNVERIFIED',
      registerProvenanceVerified: false, readinessAuthorized: false, mutationPerformed: false }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReadinessDiagnostic({ cloudId: process.env.CM_JIRA_CLOUD_ID,
    email: process.env.CM_JIRA_READINESS_EMAIL, token: process.env.CM_JIRA_READINESS_API_TOKEN,
    githubToken: process.env.CM_GITHUB_GATES_TOKEN, issueKey: process.env.CM_JIRA_ISSUE_KEY });
}
