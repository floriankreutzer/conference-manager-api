import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runIsolatedProviderWatchAttempt } from '../scripts/provider-watch-delivery-model.mjs';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const EVENT = { key: 'fixture-threshold-95', digest: 'a'.repeat(64) };
const initial = () => ({ schemaVersion: 1, pending: null, deliveries: [] });

function fixture() {
  const state = { stored: initial(), sends: 0, lookups: 0, time: NOW, status: 'delivered' };
  const ports = {
    event: EVENT,
    clock: () => state.time,
    ledger: {
      read: async () => structuredClone(state.stored),
      write: async (value) => { state.stored = structuredClone(value); },
    },
    transport: {
      async send() { state.sends += 1; return { sendId: 'fixture-receipt-1' }; },
      async lookup(sendId) { state.lookups += 1; return { sendId, status: state.status }; },
    },
  };
  return { state, ports, run: () => runIsolatedProviderWatchAttempt(ports) };
}

test('isolated warning model records acceptance and suppresses a repeated logical send', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { action: 'recorded', status: 'delivered' });
  assert.equal(f.state.stored.pending, null);
  assert.deepEqual(await f.run(), { action: 'already_recorded', status: 'delivered' });
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.lookups, 1);
});

test('collector/read/write/readback faults never reach the send port', async () => {
  for (const fault of ['read', 'write', 'readback']) {
    const f = fixture();
    if (fault === 'read') f.ports.ledger.read = async () => { throw new Error('fixture-read-failed'); };
    if (fault === 'write') f.ports.ledger.write = async () => { throw new Error('fixture-write-failed'); };
    if (fault === 'readback') f.ports.ledger.write = async () => {};
    await assert.rejects(f.run());
    assert.equal(f.state.sends, 0);
  }
});

test('unknown send outcome preserves exactly the pending key, payload digest and original clock', async () => {
  const f = fixture();
  f.ports.transport.send = async () => { throw new Error('fixture-timeout'); };
  await assert.rejects(f.run(), /fixture-timeout/);
  assert.deepEqual(f.state.stored.pending,
    { ...EVENT, createdAt: '2026-10-18T12:00:00.000Z', sendId: null });
  assert.deepEqual(f.state.stored.deliveries, []);
});

test('expired uncertain attempts stop at the 24-hour boundary, including expiry during persistence', async () => {
  for (const duringPersistence of [false, true]) {
    const f = fixture();
    if (duringPersistence) {
      f.ports.ledger.write = async (value) => { f.state.stored = value; f.state.time += 86_400_000; };
    } else {
      f.state.stored.pending = { ...EVENT, createdAt: new Date(NOW - 86_400_000).toISOString(), sendId: null };
    }
    assert.deepEqual(await f.run(), { action: 'manual_reconciliation_required' });
    assert.equal(f.state.sends, 0);
    assert.equal(f.state.lookups, 0);
  }
});

test('known receipts reconcile after the retry window without resending; lookup faults retain the receipt', async () => {
  const f = fixture();
  f.state.stored.pending = {
    ...EVENT, createdAt: new Date(NOW - 172_800_000).toISOString(), sendId: 'fixture-receipt-1',
  };
  f.ports.transport.lookup = async () => { throw new Error('fixture-lookup-failed'); };
  await assert.rejects(f.run(), /fixture-lookup-failed/);
  assert.equal(f.state.stored.pending.sendId, 'fixture-receipt-1');
  f.ports.transport.lookup = async (sendId) => ({ sendId, status: 'delivered' });
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.state.sends, 0);
});

test('final ledger write failure preserves known receipt and recovery does not resend', async () => {
  const f = fixture();
  const write = f.ports.ledger.write;
  f.ports.ledger.write = async (value) => {
    if (value.deliveries.length) throw new Error('fixture-final-write-failed');
    await write(value);
  };
  await assert.rejects(f.run(), /fixture-final-write-failed/);
  assert.equal(f.state.stored.pending.sendId, 'fixture-receipt-1');
  assert.deepEqual(f.state.stored.deliveries, []);
  f.ports.ledger.write = write;
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.state.sends, 1);
});

test('accepted, failed, bounced and delayed outcomes never masquerade as delivered or cause another warning', async () => {
  for (const status of ['accepted', 'failed', 'bounced', 'delayed']) {
    const f = fixture(); f.state.status = status;
    assert.equal((await f.run()).status, status);
    assert.deepEqual(await f.run(), { action: 'already_recorded', status });
    assert.equal(f.state.sends, 1);
  }
});

test('payload changes, foreign pending attempts, future clocks and clock rollback fail closed', async () => {
  for (const mutate of [
    (f) => { f.state.stored.pending.digest = 'b'.repeat(64); },
    (f) => { f.state.stored.pending.key = 'foreign-fixture'; },
    (f) => { f.state.stored.pending.createdAt = new Date(NOW + 1).toISOString(); },
    (f) => { f.ports.clock = (() => { let calls = 0; return () => NOW - calls++; })(); },
    (f) => { f.state.stored.pending.extra = 'not-allowed'; },
  ]) {
    const f = fixture();
    f.state.stored.pending = { ...EVENT, createdAt: new Date(NOW).toISOString(), sendId: null };
    mutate(f);
    await assert.rejects(f.run(), /PROVIDER_WATCH_MODEL_INVALID/);
    assert.equal(f.state.sends, 0);
  }
});

test('mismatched receipt and unknown provider outcome cannot clear pending evidence', async () => {
  for (const response of [{ sendId: 'foreign-receipt', status: 'delivered' },
    { sendId: 'fixture-receipt-1', status: 'unknown' }]) {
    const f = fixture(); f.ports.transport.lookup = async () => response;
    await assert.rejects(f.run(), /PROVIDER_WATCH_MODEL_INVALID/);
    assert.equal(f.state.stored.pending.sendId, 'fixture-receipt-1');
    assert.deepEqual(f.state.stored.deliveries, []);
  }
});

test('a full fixture ledger fails closed rather than dropping duplicate-suppression evidence', async () => {
  const f = fixture();
  f.state.stored.deliveries = Array.from({ length: 50 }, (_, index) =>
    ({ key: `fixture-old-${index}`, sendId: `fixture-receipt-${index}`, status: 'accepted' }));
  await assert.rejects(f.run(), /PROVIDER_WATCH_MODEL_INVALID/);
  assert.equal(f.state.sends, 0);
  assert.equal(f.state.stored.deliveries.length, 50);
});

test('actual subprocess crashes at both acceptance boundaries recover from durable isolated files without duplicate receipt', async () => {
  for (const fault of ['after_provider_acceptance', 'after_receipt_write']) {
    const directory = await mkdtemp(path.join(tmpdir(), 'cm-watch-fault-'));
    try {
      await writeFile(path.join(directory, 'ledger.json'), JSON.stringify(initial()), { mode: 0o600 });
      await writeFile(path.join(directory, 'receipts.json'), '[]', { mode: 0o600 });
      const run = (mode) => spawnSync(process.execPath,
        ['tests/fixtures/provider-watch-crash-worker.mjs', directory, mode], { encoding: 'utf8', timeout: 5000 });
      const crashed = run(fault);
      assert.equal(crashed.status, fault === 'after_provider_acceptance' ? 73 : 74, crashed.stderr);
      const pending = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')).pending;
      assert.equal(pending.key, EVENT.key);
      assert.equal(pending.digest, EVENT.digest);
      assert.equal(run('none').status, 0);
      assert.equal(run('none').status, 0);
      const receipts = JSON.parse(await readFile(path.join(directory, 'receipts.json'), 'utf8'));
      const ledger = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
      assert.equal(receipts.length, 1);
      assert.equal(ledger.deliveries.length, 1);
      assert.equal(ledger.deliveries[0].status, 'delivered');
      assert.equal(ledger.pending, null);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
