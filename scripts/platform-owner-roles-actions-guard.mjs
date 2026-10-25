import { requirePlatformOwnerRolesActionsContext } from './support/platform-owner-actions-context.mjs';

try {
  if (process.argv.length!==2) throw new Error('REFUSED');
  requirePlatformOwnerRolesActionsContext(process.env);
} catch {
  process.stderr.write('PLATFORM_OWNER_ACTIONS_REFUSED\n');
  process.exitCode=1;
}
