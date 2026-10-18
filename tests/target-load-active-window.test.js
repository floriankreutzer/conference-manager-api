import assert from 'node:assert/strict';
import test from 'node:test';
import { runTargetActiveSessionWindow } from '../scripts/support/target-load-active-window.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';

function fixture() {
  const env = targetLoadSetupEnvironment(); env.LOAD_EXPIRES_AT = new Date(NOW + 3_600_000).toISOString();
  let elapsed = 0; const starts = []; const abort = new AbortController();
  const options = { values: targetScopeValues(env), manifest: {}, transport: {}, initialActivityAgeMs: 121_000,
    signal: abort.signal, clock: () => NOW + elapsed, monotonic: () => elapsed,
    async sleep(ms) { elapsed += ms; }, async pulse(input) {
      assert.equal(input.profile, 'active200'); assert.equal(input.signal, abort.signal); starts.push(elapsed); elapsed += 200_000;
      return { profile: 'active200', requests: 1000, distinctSessionsRead: 1000, technicalErrors: 0,
        intendedArrivalIntervalMs: 200, durationMs: 200_000, warmObjectivesMet: true };
    } };
  return { options, starts, abort, advance(ms) { elapsed += ms; } };
}

test('modeled active window refreshes the same 1000-session population three times throughout the booking peak', async () => {
  const f = fixture(); const result = await runTargetActiveSessionWindow(f.options);
  assert.deepEqual(f.starts, [0, 300_000, 600_000]); assert.equal(result.durationMs, 900_000);
  assert.equal(result.requests, 3000); assert.equal(result.distinctActiveSessions, 1000);
  assert.equal(result.modeledActivityWindowMs, 600_000); assert.equal(result.refreshCadenceMs, 300_000);
  assert.equal(result.fullModeledWindowCoverageMet, true); assert.equal(result.warmObjectivesMet, true);
  assert.equal(result.businessActivityDefinitionOwnerApproved, false); assert.equal(result.simultaneousHttpConcurrencyClaim, false);
  assert.equal(JSON.stringify(result).includes('cm_session='), false);
});

test('missing recent initial identity proof, short lifetime and cancellation fail before any activity wave', async () => {
  const f = fixture();
  for (const patch of [{ initialActivityAgeMs: 180_001 }, { initialActivityAgeMs: -1 }, { signal: undefined },
    { clock: () => NOW + 3_000_000 }]) {
    await assert.rejects(runTargetActiveSessionWindow({ ...f.options, ...patch }), /^Error: LOAD_TARGET_ACTIVE_WINDOW_FAILED$/);
  }
  f.abort.abort(); await assert.rejects(runTargetActiveSessionWindow(f.options)); assert.equal(f.starts.length, 0);
});

test('an unbounded/failed wave cannot produce continuous coverage or admit the next refresh', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(runTargetActiveSessionWindow({ ...f.options, async pulse() {
    calls += 1; throw new Error('private-cookie');
  } }), /^Error: LOAD_TARGET_ACTIVE_WINDOW_FAILED$/); assert.equal(calls, 1);
  await assert.rejects(runTargetActiveSessionWindow({ ...f.options, async pulse(input) {
    const result = await f.options.pulse(input); f.advance(500_000); return result;
  } }), /^Error: LOAD_TARGET_ACTIVE_WINDOW_FAILED$/);
});
