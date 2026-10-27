import path from 'node:path';
import { executeProtectedRuntimeObservation } from './support/protected-runtime-observation-execution.mjs';
import { requireRecurringRuntimeObservationContext, recurringRuntimeObservationWindow,
  readRecurringRuntimeObservationSelection } from './support/protected-runtime-recurring-context.mjs';

try {
  if (process.argv.length !== 2) throw new Error('REFUSED');
  requireRecurringRuntimeObservationContext(process.env);
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && !recurringRuntimeObservationWindow()) throw new Error('REFUSED');
  const selection = await readRecurringRuntimeObservationSelection();
  const result = await executeProtectedRuntimeObservation(selection, process.env, path.resolve('.runtime-observation-frontend'));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch { process.stderr.write('PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');process.exitCode = 1; }
