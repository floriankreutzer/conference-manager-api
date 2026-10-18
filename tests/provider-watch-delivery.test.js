import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, rename, rm, chmod, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProviderWatchDelivery } from '../scripts/support/provider-watch-delivery.mjs';
import { createProviderWatchMailbox } from '../scripts/support/provider-watch-mailbox.mjs';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const END = '2026-11-01T00:00:00.000Z';
const POLICY = { from: 'Watch <sender@example.test>', to: 'owner@example.test', subject: 'Usage warning' };
const WARNING = { idempotencyKey: 'fixture-warning-95',
  payload: { from: POLICY.from, to: [POLICY.to], subject: POLICY.subject, text: 'Synthetic usage warning.' },
  acknowledgements: [{ source: 'neon', windowEnd: END, thresholds: [50, 70, 85, 95] }] };
const initial = () => ({ schemaVersion: 1, pending: null, deliveries: [],
  neon: { periodEnd: END, reportedThresholds: [] }, history: [{ original: 'unchanged' }], lastError: null });

function fixture() {
  const state = { stored: initial(), time: NOW, sends: 0, lookups: 0, status: 'delivered' };
  const ports = { warning: structuredClone(WARNING), policy: POLICY, clock: () => state.time,
    ledger: {
      read: async () => structuredClone(state.stored),
      async write({ expected, next }) { assert.deepEqual(state.stored, expected); state.stored = structuredClone(next); },
    },
    transport: {
      async send(value) {
        assert.deepEqual(value, { idempotencyKey: WARNING.idempotencyKey, ...WARNING.payload });
        state.sends += 1; return { sendId: 'fixture-send-1' };
      },
      async lookup(sendId) { state.lookups += 1; return { sendId, status: state.status }; },
    },
  };
  return { state, ports, run: () => runProviderWatchDelivery(ports) };
}

test('canonical delivery atomically finalizes receipt and acknowledged thresholds, preserving other ledger fields', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { action: 'recorded', status: 'delivered' });
  assert.deepEqual(f.state.stored.neon.reportedThresholds, [50, 70, 85, 95]);
  assert.deepEqual(f.state.stored.history, [{ original: 'unchanged' }]);
  assert.equal(f.state.stored.lastError, null);
  assert.equal(f.state.stored.pending, null);
  assert.equal(f.state.stored.deliveries[0].payloadSha256,
    createHash('sha256').update(JSON.stringify(WARNING.payload)).digest('hex'));
  assert.deepEqual(await f.run(), { action: 'already_recorded', status: 'delivered' });
  assert.equal(f.state.sends, 1);
});

test('completed receipt rejects changed payload and changed acknowledgements for the same key', async () => {
  for (const change of ['payload', 'acknowledgements']) {
    const f = fixture(); await f.run();
    if (change === 'payload') f.ports.warning.payload.text += ' changed';
    else f.ports.warning.acknowledgements[0].thresholds = [50];
    await assert.rejects(f.run(), /PROVIDER_WATCH_INVALID/);
    assert.equal(f.state.sends, 1);
  }
});

test('canonical event binding tolerates JSON property order without accepting changed content', async () => {
  const f = fixture(); await f.run();
  f.ports.warning = { acknowledgements: WARNING.acknowledgements, payload: { text: WARNING.payload.text,
    subject: POLICY.subject, to: [POLICY.to], from: POLICY.from }, idempotencyKey: WARNING.idempotencyKey };
  assert.equal((await f.run()).action, 'already_recorded'); assert.equal(f.state.sends, 1);
});

test('collector no-signal read is side-effect free; legacy receipts and pending are preserved without invented digest', async () => {
  const f = fixture(); f.ports.warning = null;
  assert.deepEqual(await f.run(), { action: 'no_signal' });
  f.ports.warning = WARNING;
  f.state.stored.deliveries.push({ idempotencyKey: WARNING.idempotencyKey, sendId: 'legacy-send', status: 'delivered',
    source: 'historical', createdAt: new Date(NOW).toISOString() });
  const before = structuredClone(f.state.stored);
  assert.deepEqual(await f.run(), { action: 'legacy_receipt', status: 'delivered' });
  assert.deepEqual(f.state.stored, before);
  f.state.stored.pending = { idempotencyKey: 'old-pending', sendId: null };
  assert.equal((await f.run()).reason, 'legacy_pending');
  assert.equal(f.state.sends, 0);
});

test('ledger read, write, lost write and concurrent-snapshot faults prevent sending', async () => {
  for (const fault of ['read', 'write', 'lost_write', 'concurrent']) {
    const f = fixture();
    if (fault === 'read') f.ports.ledger.read = async () => { throw new Error('private-read-error'); };
    if (fault === 'write') f.ports.ledger.write = async () => { throw new Error('private-write-error'); };
    if (fault === 'lost_write') f.ports.ledger.write = async () => {};
    if (fault === 'concurrent') {
      const read = f.ports.ledger.read; let reads = 0;
      f.ports.ledger.read = async () => {
        if (++reads === 3) f.state.stored.history.push({ concurrent: true });
        return read();
      };
    }
    await assert.rejects(f.run()); assert.equal(f.state.sends, 0);
  }
});

test('uncertain send retains original payload/key/clock; resume with no new warning executes saved event', async () => {
  const f = fixture(); const send = f.ports.transport.send;
  f.ports.transport.send = async () => { throw new Error('uncertain-acceptance'); };
  await assert.rejects(f.run());
  const pending = structuredClone(f.state.stored.pending);
  assert.deepEqual(pending.event, WARNING);
  assert.equal(pending.createdAt, new Date(NOW).toISOString());
  f.ports.warning = null; f.ports.transport.send = send;
  assert.equal((await f.run()).status, 'delivered');
  assert.equal(f.state.sends, 1);
});

test('unknown attempts expire exactly at 24h, including expiry during asynchronous readback', async () => {
  for (const duringReadback of [false, true]) {
    const f = fixture(); f.ports.transport.send = async () => { throw new Error('uncertain'); };
    await assert.rejects(f.run());
    if (duringReadback) {
      const read = f.ports.ledger.read; let reads = 0;
      f.ports.ledger.read = async () => { if (++reads === 2) f.state.time += 86_400_000; return read(); };
    } else f.state.time += 86_400_000;
    assert.equal((await f.run()).reason, 'retry_window_expired');
    assert.equal(f.state.sends, 0);
  }
});

test('known receipts reconcile after 24h without sending; lookup and final-write faults preserve receipt', async () => {
  for (const fault of ['lookup', 'final_write']) {
    const f = fixture(); const lookup = f.ports.transport.lookup; const write = f.ports.ledger.write;
    if (fault === 'lookup') f.ports.transport.lookup = async () => { throw new Error('lookup-failed'); };
    else f.ports.ledger.write = async (value) => {
      if (value.next.pending === null) throw new Error('final-write-failed');
      await write(value);
    };
    await assert.rejects(f.run());
    assert.equal(f.state.stored.pending.sendId, 'fixture-send-1');
    assert.deepEqual(f.state.stored.neon.reportedThresholds, []);
    f.state.time += 172_800_000; f.ports.warning = null;
    f.ports.transport.lookup = lookup; f.ports.ledger.write = write;
    assert.equal((await f.run()).status, 'delivered'); assert.equal(f.state.sends, 1);
  }
});

test('accepted/failed/bounced/delayed are recorded honestly and suppress a repeat send', async () => {
  for (const status of ['accepted', 'failed', 'bounced', 'delayed']) {
    const f = fixture(); f.state.status = status;
    assert.equal((await f.run()).status, status); assert.equal((await f.run()).status, status);
    assert.equal(f.state.sends, 1);
  }
});

test('mismatched provider receipt and unknown delivery state retain pending evidence', async () => {
  for (const response of [{ sendId: 'foreign-send', status: 'delivered' }, { sendId: 'fixture-send-1', status: 'unknown' }]) {
    const f = fixture(); f.ports.transport.lookup = async () => response;
    await assert.rejects(f.run(), /PROVIDER_WATCH_INVALID/);
    assert.equal(f.state.stored.pending.sendId, 'fixture-send-1');
    assert.equal(f.state.stored.deliveries.length, 0);
  }
});

test('changed pending digest, foreign event, future time and clock rollback fail closed', async () => {
  for (const mutation of ['digest', 'event', 'future', 'rollback']) {
    const f = fixture(); f.ports.transport.send = async () => { throw new Error('uncertain'); };
    await assert.rejects(f.run());
    if (mutation === 'digest') f.state.stored.pending.payloadSha256 = 'a'.repeat(64);
    if (mutation === 'event') f.ports.warning.payload.text += 'different';
    if (mutation === 'future') f.state.stored.pending.createdAt = new Date(NOW + 1).toISOString();
    if (mutation === 'rollback') { let calls = 0; f.ports.clock = () => NOW - calls++; }
    await assert.rejects(f.run(), /PROVIDER_WATCH_INVALID/); assert.equal(f.state.sends, 0);
  }
});

test('recovery does not acknowledge thresholds in a later source window', async () => {
  const f = fixture(); f.ports.transport.lookup = async () => { throw new Error('uncertain'); };
  await assert.rejects(f.run());
  f.state.stored.neon.periodEnd = '2026-12-01T00:00:00.000Z';
  f.ports.warning = null; f.ports.transport.lookup = async (sendId) => ({ sendId, status: 'delivered' });
  await f.run(); assert.deepEqual(f.state.stored.neon.reportedThresholds, []);
});

test('malformed policy/payload and full receipt ledger fail before transport', async () => {
  for (const fault of ['recipient', 'header', 'field', 'size', 'full', 'ack']) {
    const f = fixture();
    if (fault === 'recipient') f.ports.warning.payload.to = ['foreign@example.test'];
    if (fault === 'header') f.ports.policy = { ...POLICY, subject: 'Bad\r\nHeader' };
    if (fault === 'field') f.ports.warning.payload.cc = ['foreign@example.test'];
    if (fault === 'size') f.ports.warning.payload.text = 'x'.repeat(16_385);
    if (fault === 'ack') f.state.stored.neon.reportedThresholds = ['invalid'];
    if (fault === 'full') f.state.stored.deliveries = Array.from({ length: 50 }, (_, i) =>
      ({ idempotencyKey: `old-${i}`, sendId: `receipt-${i}`, status: 'accepted' }));
    await assert.rejects(f.run(), /PROVIDER_WATCH_INVALID/); assert.equal(f.state.sends, 0);
  }
});

// Fixture ports only; the child is the actual connector CLI, not a second protocol implementation.
async function bridge(directory, fault = 'none', warning = WARNING) {
  const child = spawn(process.execPath, ['scripts/provider-watch-delivery.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ warning, policy: POLICY })}\n`);
  const load = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  const save = async (name, value) => {
    const file = path.join(directory, name);
    await writeFile(`${file}.next`, JSON.stringify(value), { mode: 0o600 }); await rename(`${file}.next`, file);
  };
  let completed;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const request = JSON.parse(line); let value = null;
      if (request.operation === 'complete') { completed = request.result; break; }
      if (request.operation === 'ledger.read') value = await load('ledger.json');
      else if (request.operation === 'ledger.write') {
        assert.deepEqual(await load('ledger.json'), request.args.expected);
        await save('ledger.json', request.args.next);
        if (fault === 'after_receipt_write' && request.args.next.pending?.sendId) {
          child.kill('SIGKILL'); break;
        }
      } else if (request.operation === 'transport.send') {
        const receipts = await load('receipts.json');
        let receipt = receipts.find((item) => item.idempotencyKey === request.args.idempotencyKey);
        if (!receipt) {
          receipt = { ...request.args, sendId: 'durable-receipt-1' }; receipts.push(receipt); await save('receipts.json', receipts);
        }
        assert.deepEqual(request.args, { idempotencyKey: receipt.idempotencyKey, ...WARNING.payload });
        if (fault === 'after_acceptance') { child.kill('SIGKILL'); break; }
        value = { sendId: receipt.sendId };
      } else if (request.operation === 'transport.lookup') value = { ...request.args, status: 'delivered' };
      else assert.fail('Unexpected connector operation');
      child.stdin.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
    }
    return { ...await exited, completed, stderr };
  } finally { child.kill(); }
}

test('actual connector CLI survives SIGKILL after provider acceptance and after receipt write without duplicate receipt',
  { timeout: 20_000 }, async () => {
    for (const fault of ['after_acceptance', 'after_receipt_write']) {
      const directory = await mkdtemp(path.join(tmpdir(), 'cm-delivery-'));
      try {
        await writeFile(path.join(directory, 'ledger.json'), JSON.stringify(initial()), { mode: 0o600 });
        await writeFile(path.join(directory, 'receipts.json'), '[]', { mode: 0o600 });
        assert.equal((await bridge(directory, fault)).signal, 'SIGKILL');
        const pending = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8')).pending;
        assert.deepEqual(pending.event, WARNING);
        const recovered = await bridge(directory, 'none', null);
        assert.equal(recovered.code, 0, recovered.stderr); assert.equal(recovered.completed.status, 'delivered');
        assert.equal((await bridge(directory)).completed.action, 'already_recorded');
        assert.equal(JSON.parse(await readFile(path.join(directory, 'receipts.json'), 'utf8')).length, 1);
        const state = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
        assert.equal(state.pending, null); assert.equal(state.deliveries.length, 1);
        assert.deepEqual(state.neon.reportedThresholds, [50, 70, 85, 95]);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

test('connector CLI rejects malformed initialization, oversized input, wrong reply ID and failed ports without leaking errors',
  { timeout: 10_000 }, async () => {
    for (const fault of ['init', 'oversize', 'reply_id', 'failed_port']) {
      const child = spawn(process.execPath, ['scripts/provider-watch-delivery.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      let stderr = ''; let stdout = '';
      child.stderr.on('data', (value) => { stderr += value; });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (value) => {
        stdout += value;
        if (fault === 'reply_id' || fault === 'failed_port') {
          child.stdin.write(`${JSON.stringify({ id: fault === 'reply_id' ? 999 : 1,
            ok: fault !== 'failed_port', value: 'private-provider-error-must-not-leak' })}\n`);
        }
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        const init = fault === 'init' ? { secretError: 'private-provider-error-must-not-leak' }
          : fault === 'oversize' ? { data: 'x'.repeat(524_289) } : { warning: null, policy: POLICY };
        child.stdin.write(`${JSON.stringify(init)}\n`);
        assert.equal(await exited, 1);
        assert.equal(stderr, 'PROVIDER_WATCH_FAILED\n');
        assert.equal(stdout.includes('private-provider-error-must-not-leak'), false);
        assert.equal(stdout.includes('transport.send'), false);
      } finally { clearTimeout(timer); child.kill(); }
    }
  });

test('native mailbox connector runs the same no-signal protocol without persistent stdin or private stdout',
  { timeout: 5000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cm-native-bridge-'));
    let child;
    try {
      await writeFile(path.join(directory, 'init.json'), JSON.stringify({ warning: null, policy: POLICY }), { mode: 0o600 });
      child = spawn(process.execPath, ['scripts/provider-watch-delivery.mjs', '--mailbox', directory],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      let request;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { request = JSON.parse(await readFile(path.join(directory, '1-request.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(10);
      }
      assert.deepEqual(request, { id: 1, operation: 'ledger.read', args: null });
      const response = path.join(directory, '1-response.json');
      await writeFile(`${response}.next`, JSON.stringify({ id: 1, ok: true, value: initial() }), { mode: 0o600 });
      await rename(`${response}.next`, response);
      assert.equal(await exited, 0, stderr); assert.equal(stdout, ''); assert.equal(stderr, '');
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'complete.json'), 'utf8')),
        { operation: 'complete', result: { action: 'no_signal' } });
    } finally { child?.kill(); await rm(directory, { recursive: true, force: true }); }
  });

test('closed stdout at request or completion emits only the fixed failure message', { timeout: 10_000 }, async () => {
  for (const boundary of ['request', 'completion']) {
    const child = spawn(process.execPath, ['scripts/provider-watch-delivery.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; }); child.stdin.on('error', () => {});
    if (boundary === 'request') child.stdout.destroy();
    else child.stdout.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8'));
      assert.equal(request.operation, 'ledger.read');
      child.stdout.destroy();
      child.stdin.write(`${JSON.stringify({ id: request.id, ok: true, value: initial() })}\n`);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
      child.stdin.write(`${JSON.stringify({ warning: null, policy: POLICY })}\n`);
      assert.equal(await exited, 1);
      assert.equal(stderr, 'PROVIDER_WATCH_FAILED\n');
    } finally { clearTimeout(timer); child.kill(); }
  }
});

test('mailbox refuses shared directories, readable files, symlinks and oversized private files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cm-mailbox-boundary-'));
  try {
    await chmod(directory, 0o755);
    await assert.rejects(createProviderWatchMailbox(directory), /PRIVATE_DIRECTORY/);
    await chmod(directory, 0o700);
    const mailbox = await createProviderWatchMailbox(directory);
    await writeFile(path.join(directory, 'init.json'), '{}', { mode: 0o644 });
    await assert.rejects(mailbox.read('init.json'), /PRIVATE_FILE/);
    await chmod(path.join(directory, 'init.json'), 0o600);
    await symlink(path.join(directory, 'init.json'), path.join(directory, '1-response.json'));
    await assert.rejects(mailbox.read('1-response.json'));
    await writeFile(path.join(directory, 'init.json'), 'x'.repeat(524_289), { mode: 0o600 });
    await assert.rejects(mailbox.read('init.json'), /PRIVATE_FILE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
