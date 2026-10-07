import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresMediaObjectRepository } from '../src/persistence/postgres/media-object-repository.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';

const bytes = Buffer.from('known object bytes');
const ref = mediaObjectReference({ tenantId: '11111111-1111-4111-8111-111111111111',
  assetId: '22222222-2222-4222-8222-222222222222', kind: 'room', contentType: 'image/webp',
  byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const row = { object_key: ref.key, tenant_id: ref.tenantId, asset_id: ref.assetId,
  kind: ref.kind, content_type: ref.contentType, byte_length: ref.byteLength,
  content_sha256: Buffer.from(ref.sha256, 'hex') };

function setup(answers = {}, storageOverrides = {}, includeDemoCatalogue = false) {
  const queries = [];
  const calls = [];
  const client = { async query(query) {
    queries.push(query);
    const response = answers[query?.name];
    if (response instanceof Error) throw response;
    if (response !== undefined) return response;
    if (query?.name === 'media-object-registration-quota') return { rowCount: 1, rows: [{ count: 0 }] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const pool = { async connect() { return client; } };
  const storage = { async put(value) { calls.push(['put', value]); return value.key; },
    async get(value) { calls.push(['get', value]); return bytes; },
    async remove(value) { calls.push(['remove', value]); }, ...storageOverrides };
  return { pool, client, queries, calls,
    repository: createPostgresMediaObjectRepository(pool, { storage, includeDemoCatalogue }) };
}

test('registration commits its own durable intent, parameterizes Tenant authority and bounds inventory', async () => {
  const state = setup();
  assert.equal((await state.repository.register(ref)).key, ref.key);
  assert.equal(state.queries.at(-1), 'COMMIT');
  const insert = state.queries.find((query) => query?.name === 'media-object-register');
  assert.deepEqual(insert.values.slice(0, 6), [ref.key, ref.tenantId, ref.assetId, 'room', 'image/webp', bytes.length]);
  assert.equal(state.calls.length, 0);
  await assert.rejects(withPostgresTransaction(state.pool, () => state.repository.register(ref)), /INDEPENDENT_COMMIT/);
  const quota = setup({ 'media-object-registration-quota': { rows: [{ count: 10000 }] } });
  await assert.rejects(quota.repository.register(ref), { code: 'MEDIA_STORAGE_INVENTORY_LIMIT' });
  assert.equal(quota.queries.some((query) => query?.name === 'media-object-register'), false);
});

test('duplicate intent registration is idempotent only for identical authoritative metadata', async () => {
  const state = setup({ 'media-object-registration-existing': { rowCount: 1, rows: [row] } });
  await state.repository.register(ref);
  assert.equal(state.queries.some((query) => query?.name === 'media-object-register'), false);
  const corrupt = setup({ 'media-object-registration-existing': { rowCount: 1, rows: [{ ...row, byte_length: bytes.length + 1 }] } });
  await assert.rejects(corrupt.repository.register(ref), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
});

test('upload requires the exact transaction client and locks the independently committed intent', async () => {
  const state = setup({ 'media-object-upload-lock': { rowCount: 1, rows: [row] } });
  await assert.rejects(state.repository.putWithClient(state.client, ref, bytes), /UPLOAD_TRANSACTION_REQUIRED/);
  await withPostgresTransaction(state.pool, async (client) => {
    await assert.rejects(state.repository.putWithClient({}, ref, bytes), /UPLOAD_TRANSACTION_REQUIRED/);
    assert.equal(await state.repository.putWithClient(client, ref, bytes), ref.key);
  });
  assert.deepEqual(state.calls.map(([action]) => action), ['put', 'get']);
  assert.match(state.queries.find((query) => query?.name === 'media-object-upload-lock').text, /FOR UPDATE/);
  const missing = setup();
  await assert.rejects(withPostgresTransaction(missing.pool, (client) => missing.repository.putWithClient(client, ref, bytes)),
    { code: 'MEDIA_STORAGE_INTENT_MISSING' });
  assert.equal(missing.calls.length, 0);
});

test('upload verification failure rolls back metadata publication and read rejects corrupted data', async () => {
  const state = setup({ 'media-object-upload-lock': { rowCount: 1, rows: [row] } },
    { get: async () => Buffer.from('corrupt') });
  await assert.rejects(withPostgresTransaction(state.pool, (client) => state.repository.putWithClient(client, ref, bytes)),
    { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal(state.queries.at(-1), 'ROLLBACK');
  await assert.rejects(state.repository.read(ref, ref.key), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  const valid = setup();
  await assert.rejects(valid.repository.read(ref, `v1/foreign/${ref.assetId}`), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal(valid.calls.length, 0);
  assert.deepEqual(await valid.repository.read(ref, ref.key), bytes);
});

test('cleanup rechecks live Room and Catalogue metadata under the inventory lock', async () => {
  for (const live of ['media-object-live-room-reference', 'media-object-live-catalogue-reference']) {
    const state = setup({ 'media-object-retention-batch': { rowCount: 1, rows: [row] },
      [live]: { rowCount: 1, rows: [{}] } }, {}, true);
    assert.deepEqual(await state.repository.pruneOrphans(), { inspected: 1, deleted: 0, bytes: 0, hasMore: false });
    assert.equal(state.calls.length, 0);
    const query = state.queries.find((value) => value?.name === 'media-object-retention-batch');
    assert.match(query.text, /30 days/);
    assert.match(query.text, /NOT EXISTS/);
    assert.match(query.text, /FOR UPDATE SKIP LOCKED/);
    assert.deepEqual(query.values, [100]);
  }
});

test('cleanup removes intents only after successful idempotent storage deletion and rejects unbounded batches', async () => {
  const state = setup({ 'media-object-retention-batch': { rowCount: 1, rows: [row] } });
  assert.deepEqual(await state.repository.pruneOrphans(), { inspected: 1, deleted: 1, bytes: bytes.length, hasMore: false });
  assert.deepEqual(state.calls.map(([action]) => action), ['remove']);
  assert.deepEqual(state.queries.find((query) => query?.name === 'media-object-retention-delete-intent').values, [ref.tenantId, ref.key]);
  const failed = setup({ 'media-object-retention-batch': { rowCount: 1, rows: [row] } },
    { remove: async () => { throw new Error('DELETE_FAILED'); } });
  await assert.rejects(failed.repository.pruneOrphans(), /DELETE_FAILED/);
  assert.equal(failed.queries.some((query) => query?.name === 'media-object-retention-delete-intent'), false);
  assert.equal(failed.queries.at(-1), 'ROLLBACK');
  for (const limit of [0, 101, 1.5, '10']) await assert.rejects(state.repository.pruneOrphans({ limit }), /LIMIT_INVALID/);
});
