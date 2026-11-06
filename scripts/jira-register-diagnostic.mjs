import { pathToFileURL } from 'node:url';
import { readJiraRegister } from './jira-register-reader.mjs';

export async function runJiraRegisterDiagnostic({ write = console.log, ...options } = {}) {
  try {
    const result = await readJiraRegister(options);
    write(JSON.stringify({ schemaVersion: 1, result: 'JIRA_REGISTER_READ',
      enrollmentRequired: result.enrollmentRequired, readinessEvaluated: false, mutationPerformed: false }));
    return 0;
  } catch {
    write(JSON.stringify({ schemaVersion: 1, result: 'JIRA_REGISTER_READ_UNVERIFIED',
      readinessEvaluated: false, mutationPerformed: false }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runJiraRegisterDiagnostic({ cloudId: process.env.CM_JIRA_CLOUD_ID,
    email: process.env.CM_JIRA_READINESS_EMAIL, token: process.env.CM_JIRA_READINESS_API_TOKEN,
    issueKey: process.env.CM_JIRA_ISSUE_KEY });
}
