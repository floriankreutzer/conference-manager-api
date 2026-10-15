import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planBookingWorkload } from '../scripts/support/booking-workload-plan.mjs';

const fixture = JSON.parse(await readFile('docs/SAAS-3.8-WORKLOAD-EXAMPLE.json', 'utf8'));

test('booking plan keeps monthly volume independent of peak activity and reports unknown evidence', () => {
  const report = planBookingWorkload(fixture);
  assert.equal(report.monthlyBookings, 10_000);
  assert.equal(report.peakActiveUsers, 1_000);
  assert.equal(report.monthlyBookingRelatedOperations, 160_000);
  assert.equal(report.monthlyOperations.request_create, 10_000);
  assert.deepEqual(report.monthlyOperations, { session_read: 20_000, room_page_read: 20_000,
    availability_lookup: 20_000, request_create: 10_000, request_read: 40_000,
    request_transition: 20_000, media_read: 30_000 });
  assert.deepEqual(report.peakRequestSensitivity.map(row => row.aggregateRequestsPerSecond), [200, 1000 / 15, 1000 / 60]);
  assert.equal(report.evidenceKind, 'planning_only');
  assert.equal(report.capacityAccepted, false);
  assert.equal(report.activityMixApproved, false);
  assert.equal(report.providerCosts, 'unknown');
  assert.equal(report.backgroundAndNonBookingTraffic, 'unknown');
  assert.equal(report.simultaneousInFlightRequests, 'unknown');
  const moreUsers = planBookingWorkload({ ...fixture, peakActiveUsers: 10_000 });
  assert.deepEqual(moreUsers.monthlyOperations, report.monthlyOperations);
  assert.equal(moreUsers.peakRequestSensitivity[0].aggregateRequestsPerSecond, 2000);
  const moreBookings = planBookingWorkload({ ...fixture, monthlyBookings: 200_000 });
  assert.deepEqual(moreBookings.peakRequestSensitivity, report.peakRequestSensitivity);
  assert.equal(moreBookings.monthlyBookingRelatedOperations, 3_200_000);
});

test('closed bounded workload schema rejects unsafe, secret and ambiguous inputs', () => {
  const mutations = [
    input => { input.tenantId = 'private'; },
    input => { input.schemaVersion = 2; },
    input => { input.monthlyBookings = 0; },
    input => { input.monthlyBookings = 1_000_000_001; },
    input => { input.peakActiveUsers = 1.5; },
    input => { input.peakActiveUsers = Infinity; },
    input => { input.peakActiveUsers = '1000'; },
    input => { input.operationsPerBooking.password = 'private'; },
    input => { delete input.operationsPerBooking.media_read; },
    input => { input.operationsPerBooking.request_read = -1; },
    input => { input.operationsPerBooking.request_read = 1001; },
    input => { for (const key of Object.keys(input.operationsPerBooking)) input.operationsPerBooking[key] = 0; },
    input => { input.requestCadencesSeconds = [0]; },
    input => { input.requestCadencesSeconds = [5, 5]; },
    input => { input.requestCadencesSeconds = []; },
    input => { input.requestCadencesSeconds = Array.from({ length: 11 }, (_, index) => index + 1); },
    input => { input.requestCadencesSeconds = [86_401]; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(fixture);
    mutate(input);
    assert.throws(() => planBookingWorkload(input), /WORKLOAD_PLAN_INVALID/);
  }
  for (const input of [null, [], 'private']) assert.throws(() => planBookingWorkload(input));
});

test('maximum bounded products remain safe integers', () => {
  const input = structuredClone(fixture);
  input.monthlyBookings = 1_000_000_000;
  input.peakActiveUsers = 1_000_000;
  for (const key of Object.keys(input.operationsPerBooking)) input.operationsPerBooking[key] = 1000;
  const report = planBookingWorkload(input);
  assert.equal(report.monthlyBookingRelatedOperations, 7_000_000_000_000);
  assert.ok(Number.isSafeInteger(report.monthlyBookingRelatedOperations));
});

test('offline CLI accepts the documented example and fails without echoing malformed input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'booking-workload-'));
  const file = path.join(directory, 'input.json');
  const run = args => spawnSync(process.execPath, ['scripts/booking-workload-plan.mjs', ...args], {
    encoding: 'utf8', timeout: 5_000,
  });
  try {
    const valid = run(['docs/SAAS-3.8-WORKLOAD-EXAMPLE.json']);
    assert.equal(valid.status, 0);
    assert.equal(valid.stderr, '');
    assert.deepEqual(JSON.parse(valid.stdout), planBookingWorkload(fixture));
    for (const content of ['{"password":"private"}', 'private', ' '.repeat(16_385)]) {
      await writeFile(file, content);
      const invalid = run([file]);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, 'WORKLOAD_PLAN_FAILED\n');
    }
    for (const args of [[], [file, '--unknown'], [directory], [path.join(directory, 'missing')]]) {
      const invalid = run(args);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, 'WORKLOAD_PLAN_FAILED\n');
    }
    if (process.platform !== 'win32') {
      const fifo = path.join(directory, 'pipe');
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
      const invalid = run([fifo]);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, 'WORKLOAD_PLAN_FAILED\n');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
