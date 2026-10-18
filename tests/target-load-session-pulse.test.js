import assert from 'node:assert/strict';
import test from 'node:test';
import { runTargetSessionPulse } from '../scripts/support/target-load-session-pulse.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';
import { targetLoadManifest } from './support/target-load-manifest.js';

async function fixture() {
  const manifest = await targetLoadManifest({ population: 1000 });
  const actors = new Map(manifest.employees.map(actor => [actor.cookie, actor])); let elapsed = 0;
  const seen = new Set();
  return { seen, options: { values: targetScopeValues(targetLoadSetupEnvironment()), manifest,
    clock: () => NOW, monotonic: () => elapsed, async sleep(ms) { elapsed += ms; },
    transport: { async exchange(input) {
      assert.equal(input.kind, 'session_read'); assert.equal(input.method, 'GET'); assert.equal(input.path, '/api/v1/session');
      assert.equal(input.body, undefined); assert.equal(seen.has(input.cookie), false); seen.add(input.cookie);
      const actor = actors.get(input.cookie);
      return { status: 200, body: { user: { id: actor.userId }, tenant: { id: actor.tenantId }, roles: ['employee'],
        csrfToken: 'c'.repeat(43) }, latencyMs: 1, payloadBytes: 100 };
    } } } };
}

test('separate session pulse bounds one read per distinct actor and does not claim active-user or booking capacity', async () => {
  const f = await fixture(); const result = await runTargetSessionPulse(f.options);
  assert.equal(f.seen.size, 1000); assert.equal(result.requests, 1000); assert.equal(result.payloadBytes, 100_000);
  assert.equal(result.intendedArrivalIntervalMs, 60); assert.equal(result.thousandSimultaneouslyActiveUsersProven, false);
  assert.equal(result.concurrentBookingCapacityProven, false); assert.equal(JSON.stringify(result).includes('cm_session='), false);
});

test('a foreign session response aborts the pulse without further reads or private diagnostics', async () => {
  const f = await fixture(); let reads = 0;
  await assert.rejects(runTargetSessionPulse({ ...f.options, transport: { async exchange() {
    reads += 1; throw new Error('private-session-body');
  } } }), /^Error: LOAD_TARGET_SESSION_PULSE_FAILED$/);
  assert.ok(reads >= 1 && reads <= 16);
});
