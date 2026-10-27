import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireRecurringRuntimeObservationContext, readRecurringRuntimeObservationSelection }
  from './support/protected-runtime-recurring-context.mjs';
import { PROTECTED_OBSERVATION_ORIGINS } from './support/protected-runtime-observation-plan.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  requireRecurringRuntimeObservationContext(process.env);
  const selection = await readRecurringRuntimeObservationSelection();
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: '.runtime-observation-source', encoding: 'utf8' }).trim()
    !== selection.frontendCommit) throw new Error('REFUSED');
  execFileSync(process.execPath, ['scripts/build-protected-frontend.mjs', path.resolve('.runtime-observation-frontend')], {
    cwd: '.runtime-observation-source', stdio: 'inherit', timeout: 60000,
    env: { ...process.env, PROTECTED_ENVIRONMENT: 'int', PROTECTED_API_COMMIT: selection.apiCommit,
      PROTECTED_FRONTEND_COMMIT: selection.frontendCommit, PROTECTED_SYNTHETIC_ENABLED: 'true',
      PROTECTED_CUSTOMER_ORIGIN: PROTECTED_OBSERVATION_ORIGINS.customer,
      PROTECTED_PLATFORM_ORIGIN: PROTECTED_OBSERVATION_ORIGINS.platform,
      PROTECTED_PRESENTATION_MICROSOFT_ENABLED: 'true', PROTECTED_PRESENTATION_INVITATIONS_ENABLED: 'true',
      PROTECTED_OWNER_CUSTOMER_ACCESS_ENABLED: 'true' },
  });
} catch { process.stderr.write('PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');process.exitCode = 1; }
