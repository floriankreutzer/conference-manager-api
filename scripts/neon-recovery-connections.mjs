import { Client } from 'pg';
import { open } from 'node:fs/promises';
import { CONNECTION_REPORT, runNeonRecoveryConnections } from './support/neon-recovery-connections.mjs';

let file;
let report;
const provisioned = Date.parse(process.env.NEON_RECOVERY_PROVISIONED_AT);
const preparationRemaining = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(process.env.NEON_RECOVERY_PROVISIONED_AT || '')
  && Number.isFinite(provisioned) ? provisioned + 30 * 60_000 - Date.now() : 60_000;
const watchdog = setTimeout(() => {
  process.stderr.write('NEON_RECOVERY_CONNECTIONS_HARD_TIMEOUT\n');
  process.exit(1);
}, Math.max(1, Math.min(60_000, preparationRemaining)));
function expired() {
  return report && report.outcome === 'passed' && (Date.now() >= Date.parse(report.preparationDeadline)
    || (report.markerExpiresAt && Date.now() >= Date.parse(report.markerExpiresAt)));
}
try {
  if (process.argv.length !== 2) throw new Error('NEON_RECOVERY_ARGUMENTS_INVALID');
  // Reserve exclusively before any connection so a local rerun cannot overwrite evidence.
  file = await open(CONNECTION_REPORT, 'wx', 0o600);
  report = await runNeonRecoveryConnections({ env: process.env, clientFactory: (options) => new Client(options) });
  if (expired()) {
    report.outcome = 'failed';
    report.failedStage = 'report';
    report.code = 'NEON_RECOVERY_DEADLINE';
  }
  await file.writeFile(`${JSON.stringify(report)}\n`);
  if (report.outcome !== 'passed') {
    process.exitCode = 1;
    process.stderr.write('NEON_RECOVERY_CONNECTIONS_FAILED\n');
  }
} catch {
  process.exitCode = 1;
  process.stderr.write('NEON_RECOVERY_CONNECTIONS_REPORT_FAILED\n');
} finally {
  if (file) {
    try { await file.close(); }
    catch { process.exitCode = 1; process.stderr.write('NEON_RECOVERY_CONNECTIONS_REPORT_CLOSE_FAILED\n'); }
  }
}
if (expired()) {
  process.exitCode = 1;
  process.stderr.write('NEON_RECOVERY_CONNECTIONS_REPORT_EXPIRED\n');
}
clearTimeout(watchdog);
// A failed bounded close must not leave a pending socket or query alive.
process.exit(process.exitCode || 0);
