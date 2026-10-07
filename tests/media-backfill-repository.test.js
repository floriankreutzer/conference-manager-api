import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresMediaBackfillRepository } from '../src/persistence/postgres/media-backfill-repository.js';

const bytes = Buffer.from('retained verified bytes');
const digest = createHash('sha256').update(bytes).digest();
const tenantId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const key = `v1/${tenantId}/room/${assetId}/${digest.toString('hex')}`;
const evidence = 'a'.repeat(64);
const row = { tenant_id: tenantId, id: assetId, content_type: 'image/webp',
  byte_length: bytes.length, content_sha256: digest, bytes, object_key: key };

function setup({ locked = row, restored = bytes, failure = false, includeDemoCatalogue = false } = {}) {
  const events = [];
  const query = async (input) => {
    events.push(input);
    if (input?.name?.startsWith('media-backfill-candidates')) return { rowCount: 1, rows: [row] };
    if (input?.name?.startsWith('media-backfill-lock')) return { rowCount: locked ? 1 : 0, rows: locked ? [locked] : [] };
    return { rowCount: 1, rows: [] };
  };
  const client = { query, release() {} };
  const pool = { query, async connect() { return client; } };
  const mediaObjects = {
    async register(reference) { events.push(['register', reference]); },
    async putWithClient(actualClient, reference, value) {
      assert.equal(actualClient, client);
      assert.deepEqual(value, bytes);
      events.push(['put', reference]);
      if (failure) throw new Error('VERIFY_FAILED');
      return reference.key;
    },
    async read(reference, persistedKey) { events.push(['read', reference, persistedKey]); return restored; },
  };
  return { events, repository: createPostgresMediaBackfillRepository(pool, { mediaObjects, includeDemoCatalogue }) };
}

test('copy commits durable intent before row lock, verifies the source and preserves database bytes', async () => {
  const state = setup();
  assert.deepEqual(await state.repository.runBatch({ phase: 'copy', kind: 'room' }),
    { phase: 'copy', kind: 'room', inspected: 1, changed: 1, byteLength: bytes.length, hasMore: false });
  const registered = state.events.findIndex((event) => event[0] === 'register');
  const begin = state.events.findIndex((event) => typeof event === 'string' && event.startsWith('BEGIN'));
  assert.ok(registered < begin);
  const update = state.events.find((event) => event?.name === 'media-backfill-copy-room');
  assert.match(update.text, /SET object_key = \$3/);
  assert.doesNotMatch(update.text, /SET bytes|bytes = NULL/);
  assert.deepEqual(update.values, [tenantId, assetId, key]);
  assert.equal(state.events.at(-1), 'COMMIT');
});

test('copy rejects corrupted retained bytes and provider verification failures without publishing', async () => {
  for (const change of [{ locked: { ...row, bytes: Buffer.from('corrupt') } }, { failure: true }]) {
    const state = setup(change);
    await assert.rejects(state.repository.runBatch({ phase: 'copy', kind: 'room' }));
    assert.equal(state.events.at(-1), 'ROLLBACK');
    assert.equal(state.events.some((event) => event?.name === 'media-backfill-copy-room'), false);
  }
});

test('a replaced or concurrently locked row is skipped without provider access', async () => {
  for (const locked of [null, { ...row, content_sha256: Buffer.alloc(32) }]) {
    const state = setup({ locked });
    const result = await state.repository.runBatch({ phase: 'rollback', kind: 'room' });
    assert.equal(result.changed, 0);
    assert.equal(state.events.some(Array.isArray), false);
    assert.match(state.events.find((event) => event?.name === 'media-backfill-lock-rollback-room').text, /SKIP LOCKED/);
  }
});

test('rollback restores verified provider bytes atomically before clearing the key and keeps object custody', async () => {
  const state = setup({ locked: { ...row, bytes: null } });
  await state.repository.runBatch({ phase: 'rollback', kind: 'room' });
  const update = state.events.find((event) => event?.name === 'media-backfill-rollback-room');
  assert.match(update.text, /SET bytes = \$3, object_key = NULL/);
  assert.deepEqual(update.values, [tenantId, assetId, bytes]);
  assert.equal(state.events.at(-1), 'COMMIT');
  assert.equal(state.events.some((event) => typeof event?.text === 'string' && /DELETE FROM/.test(event.text)), false);
});

test('rollback never clears a foreign persisted pointer or corrupt/missing provider object', async () => {
  for (const change of [{ locked: { ...row, object_key: key.replace(tenantId, assetId) } },
    { restored: Buffer.from('corrupt') }, { restored: undefined }]) {
    const state = setup(change.restored === undefined && Object.hasOwn(change, 'restored') ? { restored: null } : change);
    await assert.rejects(state.repository.runBatch({ phase: 'rollback', kind: 'room' }),
      { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
    assert.equal(state.events.at(-1), 'ROLLBACK');
    assert.equal(state.events.some((event) => event?.name === 'media-backfill-rollback-room'), false);
  }
});

test('purge requires explicit retained restore evidence and verifies both copies immediately before dropping bytes', async () => {
  const state = setup();
  await assert.rejects(state.repository.runBatch({ phase: 'purge', kind: 'room' }), /RESTORE_EVIDENCE_REQUIRED/);
  assert.deepEqual(state.events, []);
  await state.repository.runBatch({ phase: 'purge', kind: 'room', restoreEvidenceSha256: evidence });
  const update = state.events.find((event) => event?.name === 'media-backfill-purge-room');
  assert.match(update.text, /SET bytes = NULL/);
  for (const change of [{ restored: Buffer.from('corrupt') }, { locked: { ...row, bytes: Buffer.from('corrupt') } }]) {
    const failed = setup(change);
    await assert.rejects(failed.repository.runBatch({ phase: 'purge', kind: 'room', restoreEvidenceSha256: evidence }));
    assert.equal(failed.events.some((event) => event?.name === 'media-backfill-purge-room'), false);
  }
});

test('operator phases, tables and batch bounds are closed and Catalogue requires explicit scope', async () => {
  for (const input of [{ phase: 'unknown', kind: 'room' }, { phase: 'copy', kind: 'room;DROP' },
    { phase: 'copy', kind: 'catalogue' }, ...[0, 11, '10', 1.5].map((limit) => ({ phase: 'copy', kind: 'room', limit }))]) {
    const state = setup();
    await assert.rejects(state.repository.runBatch(input), /INPUT_INVALID/);
    assert.deepEqual(state.events, []);
  }
  const state = setup();
  await state.repository.runBatch({ phase: 'copy', kind: 'room', limit: 1 });
  assert.deepEqual(state.events[0].values, [1]);
});
