import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadTargetScope, loadTargetOrigin, loadObserverAuthorized, assertLoadDatabase } from '../scripts/support/target-load-guard.mjs';
import { createTargetLoadCalendar } from '../scripts/support/target-load-calendar.mjs';

const runId = '0123456789abcdef';
const now = Date.parse('2026-10-16T12:00:00.000Z');
const host = 'ep-synthetic-fixture.c-5.eu-central-1.aws.neon.tech';
const values = Object.freeze({ runId, createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 7200000).toISOString(), releaseSha: 'a'.repeat(40), surface: 'customer',
  databaseUrl: `postgres://saas38_load_${runId}_customer:synthetic-test-only@${host}/saas38_load_${runId}?sslmode=verify-full`,
  expectedDatabaseHost: host, observerToken: 'x'.repeat(43), storageBucket: `saas38-load-${runId}`,
  serviceName: `cm-saas38-load-${runId}-customer` });

test('remote load target refuses wrong origins, Demo database, elevated roles and expired scope', async () => {
  const scope = loadTargetScope(values, now);
  assert.equal(scope.databaseName, `saas38_load_${runId}`);
  for (const patch of [
    { runId: 'demo' }, { surface: 'demo' }, { releaseSha: 'main' }, { observerToken: 'short' },
    { storageBucket: 'conference-manager-media' }, { expectedDatabaseHost: 'localhost' },
    { serviceName: 'conference-manager-demo' }, { createdAt: new Date(now + 1).toISOString() },
    { expiresAt: new Date(now + 7200001).toISOString() },
    { databaseUrl: values.databaseUrl.replace(`/saas38_load_${runId}?`, '/neondb?') },
    { databaseUrl: values.databaseUrl.replace('_customer:', '_platform:') },
    { databaseUrl: values.databaseUrl.replace(host, 'ep-other.c-5.eu-central-1.aws.neon.tech') },
    { databaseUrl: values.databaseUrl.replace('verify-full', 'require') },
    { databaseUrl: values.databaseUrl + '&sslmode=verify-full' },
    { databaseUrl: values.databaseUrl + '&options=unsafe' },
  ]) assert.throws(() => loadTargetScope({ ...values, ...patch }, now), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  assert.throws(() => loadTargetScope(values, now + 7200000));
  const origin = `https://cm-saas38-load-${runId}-customer.onrender.com`;
  assert.equal(loadTargetOrigin(origin, runId, 'customer'), origin);
  for (const value of [origin + '/', origin + '?x=1', origin.replace('https:', 'http:'),
    origin.replace('.onrender.com', '.onrender.com.evil.invalid'), 'https://conference-manager-demo.onrender.com']) {
    assert.throws(() => loadTargetOrigin(value, runId, 'customer'));
  }
  assert.equal(loadObserverAuthorized(`Bearer ${values.observerToken}`, values.observerToken), true);
  for (const value of [null, '', `Basic ${values.observerToken}`, `Bearer ${'y'.repeat(43)}`]) {
    assert.equal(loadObserverAuthorized(value, values.observerToken), false);
  }
  const base = [
    { rows: [{ database: scope.databaseName, actor: scope.databaseUser, version: 180006 }] },
    { rowCount: 1, rows: [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false,
      managed_superuser: false, role_membership: false }] },
    { rows: [{ marker: 'saas38_load_scope' }] },
    { rowCount: 1, rows: [{ run_id: runId, release_sha: values.releaseSha,
      created_at: new Date(now), expires_at: new Date(now + 7200000) }] },
  ];
  async function verify(responses) {
    let call = 0;
    await assertLoadDatabase({ async query() { return responses[call++]; } }, scope, { clock: () => now });
    assert.equal(call, 4);
  }
  await verify(base);
  for (const key of Object.keys(base[1].rows[0])) {
    const changed = structuredClone(base); changed[1].rows[0][key] = true;
    await assert.rejects(() => verify(changed));
  }
  const changed = structuredClone(base); changed[3].rows[0].run_id = 'ffffffffffffffff';
  await assert.rejects(() => verify(changed));
});

test('controlled calendar preserves Tenant scope, immutable idempotency, exact UTC and hard bounds', async () => {
  const bindings = new Map(Array.from({ length: 10 }, (_, i) => [randomUUID(), { address: `room${i}@synthetic.invalid` }]));
  const entries = [...bindings]; const fixture = createTargetLoadCalendar(bindings); bindings.clear();
  const input = { tenantReference: entries[0][0], resourceAddress: entries[0][1].address,
    startsAt: '2026-11-04T09:00:00.000Z', endsAt: '2026-11-04T10:00:00.000Z', idempotencyKey: 'a'.repeat(64) };
  const lookup = { ...input, schedules: [input.resourceAddress] };
  assert.equal((await fixture.client.lookupFreeBusy(lookup))[0].available, true);
  assert.equal((await fixture.client.createCalendarEvent(input)).disposition, 'created');
  assert.equal((await fixture.client.createCalendarEvent(input)).disposition, 'existing');
  assert.equal((await fixture.client.lookupFreeBusy(lookup))[0].conflictCount, 1);
  await assert.rejects(() => fixture.client.createCalendarEvent({ ...input, tenantReference: entries[1][0] }));
  await assert.rejects(() => fixture.client.createCalendarEvent({ ...input, endsAt: '2026-11-04T11:00:00.000Z' }));
  await assert.rejects(() => fixture.client.lookupFreeBusy({ ...lookup, startsAt: '2026-11-04T09:00:00Z' }));
  await assert.rejects(() => fixture.client.lookupFreeBusy({ ...lookup,
    schedules: [input.resourceAddress, input.resourceAddress] }));
  for (const name of ['updateCalendarEvent', 'cancelCalendarEvent', 'verifyBasePermissions', 'adminConsentUrl', 'discoverRooms']) {
    assert.throws(() => fixture.client[name](input), /LOAD_PROVIDER_OPERATION_FORBIDDEN/);
  }
  for (let i = 1; i < 1000; i += 1) {
    await fixture.client.createCalendarEvent({ ...input, idempotencyKey: i.toString(16).padStart(64, '0') });
  }
  await assert.rejects(() => fixture.client.createCalendarEvent({ ...input, idempotencyKey: 'b'.repeat(64) }),
    /LOAD_CALENDAR_BOUNDS_INVALID/);
  assert.equal((await fixture.client.createCalendarEvent(input)).disposition, 'existing');
  assert.equal(fixture.snapshot().uniqueEvents, 1000);
});

test('database guard rechecks expiry across I/O and hides private dependency errors', async () => {
  const scope = loadTargetScope(values, now);
  let calls = 0; let clock = now;
  const identity = { rows: [{ database: scope.databaseName, actor: scope.databaseUser, version: 180006 }] };
  const rights = { rowCount: 1, rows: [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false,
    rolbypassrls: false, rolreplication: false, managed_superuser: false, role_membership: false }] };
  const expiredDuringQuery = { async query() { calls += 1; clock = scope.expiresMs; return identity; } };
  await assert.rejects(assertLoadDatabase(expiredDuringQuery, scope, { clock: () => clock }),
    /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  assert.equal(calls, 1, 'No further SQL may run after expiration during the identity query');
  calls = 0;
  await assert.rejects(assertLoadDatabase({ async query() { calls += 1; return identity; } }, scope,
    { clock: () => scope.expiresMs }), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
  assert.equal(calls, 0);
  for (const patch of [{}, { rolsuper: false }, { ...rights.rows[0], role_membership: null }]) {
    calls = 0;
    await assert.rejects(assertLoadDatabase({ async query() {
      calls += 1; return calls === 1 ? identity : { rowCount: 1, rows: [patch] };
    } }, scope, { clock: () => now }), /^Error: LOAD_TARGET_SCOPE_INVALID$/);
    assert.equal(calls, 2);
  }
  await assert.rejects(assertLoadDatabase({ async query() {
    throw new Error('private-password-and-database-details');
  } }, scope, { clock: () => now }), error => {
    assert.equal(error.message, 'LOAD_TARGET_SCOPE_INVALID'); assert.equal(error.cause, undefined); return true;
  });
});

test('only the setup identity can accept an actually empty target database', async () => {
  const setup = loadTargetScope({ ...values, surface: 'setup', serviceName: undefined,
    databaseUrl: values.databaseUrl.replace('_customer:', '_setup:') }, now);
  for (const [scope, count, accepted] of [[setup, 0, true], [setup, 1, false], [loadTargetScope(values, now), 0, false]]) {
    let calls = 0;
    const responses = [
      { rows: [{ database: scope.databaseName, actor: scope.databaseUser, version: 180006 }] },
      { rowCount: 1, rows: [{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false,
        managed_superuser: false, role_membership: false }] },
      { rows: [{ marker: null }] }, { rows: [{ count }] },
    ];
    const operation = assertLoadDatabase({ async query() { return responses[calls++]; } }, scope,
      { allowEmpty: true, clock: () => now });
    if (accepted) await operation;
    else await assert.rejects(operation, /^Error: LOAD_TARGET_SCOPE_INVALID$/);
    assert.equal(calls, scope.surface === 'setup' ? 4 : 3);
  }
  const invalidBindings = new Map(Array.from({ length: 10 }, (_, index) => [
    index === 0 ? '-'.repeat(36) : randomUUID(), { address: `room${index}@synthetic.invalid` },
  ]));
  assert.throws(() => createTargetLoadCalendar(invalidBindings), /^Error: LOAD_CALENDAR_BINDINGS_INVALID$/);
  const duplicateAddresses = new Map(Array.from({ length: 10 }, () => [randomUUID(), { address: 'room0@synthetic.invalid' }]));
  assert.throws(() => createTargetLoadCalendar(duplicateAddresses), /^Error: LOAD_CALENDAR_BINDINGS_INVALID$/);
  const reference = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const duplicateIdentifiers = new Map(Array.from({ length: 10 }, (_, index) => [
    index < 2 ? (index === 0 ? reference : reference.toUpperCase()) : randomUUID(),
    { address: `room${index}@synthetic.invalid` },
  ]));
  assert.throws(() => createTargetLoadCalendar(duplicateIdentifiers), /^Error: LOAD_CALENDAR_BINDINGS_INVALID$/);
});
