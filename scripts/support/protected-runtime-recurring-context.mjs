import { open } from 'node:fs/promises';
import { normalizeRuntimeObservationSelection, refuseRuntimeObservation } from './protected-runtime-observation-plan.mjs';

export const RECURRING_OBSERVATION_CRON = '*/5 7-17 * * *';
export function requireRecurringRuntimeObservationContext(env) {
  const repository = 'floriankreutzer/conference-manager-api';
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_ACTOR !== 'floriankreutzer' || env.GITHUB_TRIGGERING_ACTOR !== 'floriankreutzer'
    || env.GITHUB_RUN_ATTEMPT !== '1' || env.OBSERVATION_REPOSITORY_PRIVATE !== 'false'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') || env.QUALIFIED_OBSERVER_SHA !== env.GITHUB_SHA
    || env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/protected-int-runtime-recurring.yml@refs/heads/main`
    || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || (env.GITHUB_EVENT_NAME === 'schedule' ? env.OBSERVATION_SCHEDULE !== RECURRING_OBSERVATION_CRON
      : env.EXPECTED_MAIN_SHA !== env.GITHUB_SHA)
    || [env.RUNNER_DEBUG, env.ACTIONS_STEP_DEBUG, env.ACTIONS_RUNNER_DEBUG, env.NODE_OPTIONS].some(Boolean)) {
    refuseRuntimeObservation();
  }
}

// Daily 09:00 <= local time < 19:00, including DST transitions. A bounded INT
// observation window avoids keeping two Free services awake around the clock.
export function recurringRuntimeObservationWindow(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) refuseRuntimeObservation();
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now));
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  if (!Number.isInteger(hour)) refuseRuntimeObservation();
  return hour >= 9 && hour < 19;
}

// Fixed reviewed deployment metadata, never a workflow/browser selector. The
// qualified observer source and the observed deployed API are separate facts.
export async function readRecurringRuntimeObservationSelection() {
  const file = new URL('../data/protected-int-runtime-selection.json', import.meta.url);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead > 4096) refuseRuntimeObservation();
    return normalizeRuntimeObservationSelection(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle.close(); }
}
