import path from 'node:path';
import { readFixedDescriptorJson } from './lib/fixed-descriptor-json.mjs';
import { requireOwnerMainActionsContext } from './support/owner-main-actions-context.mjs';
import { normalizeRuntimeObservationSelection, refuseRuntimeObservation }
  from './support/protected-runtime-observation-plan.mjs';
import { executeProtectedRuntimeObservation } from './support/protected-runtime-observation-execution.mjs';

try {
  if (process.argv.length !== 2) refuseRuntimeObservation();
  requireOwnerMainActionsContext(process.env, 'protected-int-runtime-observation.yml');
  const selection = normalizeRuntimeObservationSelection(readFixedDescriptorJson(3));
  if (selection.apiCommit !== process.env.GITHUB_SHA) refuseRuntimeObservation();
  const result = await executeProtectedRuntimeObservation(selection, process.env, path.resolve('.runtime-observation-frontend'));
  // Minimized deployment-process receipt, not a forged Platform operator audit.
  // No signing key, identity, routing IDs, epoch or connection detail is output.
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('PROTECTED_RUNTIME_OBSERVATION_REFUSED\n');process.exitCode = 1;
}
