import { requirePlatformAuditActionsContext } from './support/platform-audit-actions-context.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  requirePlatformAuditActionsContext(process.env);
} catch {
  process.stderr.write('PLATFORM_AUDIT_ACTIONS_REFUSED\n');
  process.exitCode = 1;
}
