import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { runTargetBookingCampaign } from '../scripts/support/target-load-campaign.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';
import { targetLoadManifest } from './support/target-load-manifest.js';

async function fixture(population = 100) {
  const env = targetLoadSetupEnvironment(); env.LOAD_EXPIRES_AT = new Date(NOW + 3_600_000).toISOString();
  const manifest = await targetLoadManifest({ population, expiresAt: env.LOAD_EXPIRES_AT });
  const calls = []; let elapsed = 0;
  return { calls, options: { values: targetScopeValues(env), manifest, transport: { exchange() {} },
    clock: () => NOW, monotonic: () => elapsed, async sleep(ms) { elapsed += ms; },
    async journey(input) {
      calls.push(input); return { requestId: randomUUID(), observations: Array.from({ length: 16 }, () => ({ latencyMs: 1 })) };
    } } };
}

test('target campaign fixes 200 starts at 4.5 seconds, bounds workers and separates retained from participating actors', async () => {
  const f = await fixture(1000); const result = await runTargetBookingCampaign(f.options);
  assert.equal(result.results.length, 200); assert.equal(result.intendedArrivalIntervalMs, 4500);
  assert.equal(result.retainedEmployees, 1000); assert.equal(result.participatingEmployees, 200);
  assert.equal(result.participatingManagers, 10); assert.equal(result.results.at(-1).scheduledAtMs, 895_500);
  assert.equal(new Set(f.calls.map(call => call.employee.userId)).size, 200);
  assert.equal(new Set(f.calls.map(call => call.manager.userId)).size, 10);
  for (let index = 0; index < f.calls.length; index += 1) {
    assert.equal(f.calls[index].employee.tenantId, f.calls[index].manager.tenantId);
    assert.equal(result.results[index].observations.length, 16);
    assert.ok(result.results[index].scheduleLagMs >= 0);
    assert.equal(f.calls[index].images.length, 3);
  }
});

test('invalid profile, population, source, lifetime or slot bounds fail before any booking work', async () => {
  const f = await fixture();
  for (const change of [{ profile: 'unknown' }, { profile: 'target200' }, { profile: 'sample10', slotOffset: -1 },
    { profile: 'sample10', slotOffset: 101 }, { profile: 'sample10', clock: () => NOW + 3_599_000 }]) {
    await assert.rejects(runTargetBookingCampaign({ ...f.options, ...change }), /^Error: LOAD_TARGET_CAMPAIGN_FAILED$/);
  }
  assert.equal(f.calls.length, 0);
});

test('a journey failure aborts admitted peers and stops new work without retrying writes', async () => {
  const f = await fixture(); let started = 0; let stopped = 0;
  await assert.rejects(runTargetBookingCampaign({ ...f.options, profile: 'sample10', async journey(input) {
    started += 1;
    if (started === 1) throw new Error('private-provider-cookie');
    await new Promise(resolve => {
      if (input.signal.aborted) { stopped += 1; resolve(); }
      else input.signal.addEventListener('abort', () => { stopped += 1; resolve(); }, { once: true });
    });
    throw new Error('aborted');
  } }), /^Error: LOAD_TARGET_CAMPAIGN_FAILED$/);
  assert.equal(started, 4); assert.equal(stopped, 3);
});

test('an already canceled combined workload cannot admit a booking or restart its write budget', async () => {
  const f = await fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(runTargetBookingCampaign({ ...f.options, profile: 'sample10', signal: abort.signal }),
    /^Error: LOAD_TARGET_CAMPAIGN_FAILED$/);
  await assert.rejects(runTargetBookingCampaign({ ...f.options, profile: 'sample10', signal: {} }),
    /^Error: LOAD_TARGET_CAMPAIGN_FAILED$/);
  assert.equal(f.calls.length, 0);
});
