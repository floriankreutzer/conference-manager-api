import { execFileSync } from 'node:child_process';
import { requireRecurringRuntimeObservationContext, recurringRuntimeObservationWindow,
  readRecurringRuntimeObservationSelection } from './support/protected-runtime-recurring-context.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  requireRecurringRuntimeObservationContext(process.env);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.GITHUB_SHA) throw new Error('REFUSED');
  await readRecurringRuntimeObservationSelection();
  const active = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || recurringRuntimeObservationWindow();
  process.stdout.write(`active=${active}\n`);
} catch { process.stderr.write('PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');process.exitCode = 1; }
