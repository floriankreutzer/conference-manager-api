import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPostgresRoomMediaRepository } from '../src/persistence/postgres/room-media-repository.js';
import { createPostgresDemoCatalogueMediaRepository } from '../src/persistence/postgres/demo-catalogue-media-repository.js';
import { asApiError } from '../src/api-error.js';
import { MediaObjectStorageError } from '../src/media/object-storage-contract.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const bytes = Buffer.from('sanitized image bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const roomUpload = { tenantId: TENANT, roomId: 'room', actorUserId: USER,
  image: { bytes, width: 1, height: 1, contentType: 'image/webp' }, auditEvent: () => ({}) };
const catalogueUpload = { tenantId: TENANT, ownerKind: 'catering_item', ownerId: 'item',
  actorUserId: USER, contentType: 'image/webp', bytes, altText: 'Image', auditEvent: () => ({}) };

function harness(answers = {}, failure = null) {
  const events = [];
  const query = async (value) => {
    events.push(value);
    if (answers[value?.name] !== undefined) return answers[value.name];
    if (value?.name?.includes('quota')) return { rowCount: 1, rows: [{ used: 0 }] };
    if (value?.name?.includes('existing')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ id: ASSET }] };
  };
  const client = { query, release() {} };
  const pool = { query, async connect() { return client; } };
  const mediaObjects = {
    async register(ref) { events.push(['register', ref]); },
    async putWithClient(actualClient, ref, value) {
      assert.equal(actualClient, client);
      assert.deepEqual(value, bytes);
      events.push(['put', ref]);
      if (failure === 'put') throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
      return ref.key;
    },
    async read(ref, key) { events.push(['read', ref, key]); return bytes; },
  };
  const auditRepository = { async appendWithClient() {
    events.push(['audit']);
    if (failure === 'audit') throw new Error('AUDIT_FAILED');
  } };
  return { events,
    room: createPostgresRoomMediaRepository(pool, { mediaObjects, auditRepository }),
    catalogue: createPostgresDemoCatalogueMediaRepository(pool, { mediaObjects, auditRepository }) };
}

test('Room upload denies foreign owner and quota before registering or touching storage', async () => {
  const foreign = harness({ 'room-media-object-preflight-owner': { rowCount: 0, rows: [] } });
  assert.equal(await foreign.room.create(roomUpload), null);
  assert.equal(foreign.events.some(Array.isArray), false);
  const quota = harness({ 'room-media-object-preflight-quota': { rows: [{ used: 100 * 1024 * 1024 }] } });
  assert.deepEqual(await quota.room.create(roomUpload), { status: 'quota_exceeded' });
  assert.equal(quota.events.some(Array.isArray), false);
});

test('Room publication registers before the transaction and publishes only verified object metadata with audit', async () => {
  const state = harness();
  const result = await state.room.create(roomUpload);
  assert.equal(result.status, 'created');
  const registration = state.events.find((event) => event[0] === 'register');
  assert.equal(registration[1].tenantId, TENANT);
  assert.equal(registration[1].sha256, sha256);
  assert.equal(registration[1].assetId, result.assetId);
  const begin = state.events.findIndex((event) => typeof event === 'string' && event.startsWith('BEGIN'));
  assert.ok(state.events.indexOf(registration) < begin);
  const insert = state.events.find((event) => event?.name === 'room-media-insert');
  assert.equal(insert.values[3], null);
  assert.equal(insert.values[9], registration[1].key);
  assert.equal(state.events.at(-1), 'COMMIT');
});

test('failed provider verification or audit never commits Room publication', async () => {
  for (const failure of ['put', 'audit']) {
    const state = harness({}, failure);
    await assert.rejects(state.room.create(roomUpload));
    assert.equal(state.events.at(-1), 'ROLLBACK');
    assert.equal(state.events.includes('COMMIT'), false);
    if (failure === 'put') assert.equal(state.events.some((event) => event?.name === 'room-media-insert'), false);
  }
});

test('Room reads authorize attachment before storage and never fall back to database bytes in object mode', async () => {
  const absent = harness({ 'room-media-attached-read': { rows: [] } });
  const read = { tenantId: TENANT, roomId: 'room', assetId: ASSET, includeInactive: false };
  assert.equal(await absent.room.findAttached(read), null);
  assert.equal(absent.events.some(Array.isArray), false);
  const legacy = harness({ 'room-media-attached-read': { rows: [{ bytes, content_type: 'image/webp' }] } });
  await assert.rejects(legacy.room.findAttached(read), { code: 'MEDIA_STORAGE_BACKFILL_REQUIRED' });
  const key = `v1/${TENANT}/room/${ASSET}/${sha256}`;
  const valid = harness({ 'room-media-attached-read': { rows: [{ object_key: key,
    content_type: 'image/webp', byte_length: bytes.length, content_sha256: Buffer.from(sha256, 'hex') }] } });
  assert.deepEqual(await valid.room.findAttached(read), { bytes, contentType: 'image/webp' });
  assert.deepEqual(valid.events.at(-1).slice(0, 1), ['read']);
  assert.match(valid.events[0].text, /room.active/);
  assert.match(valid.events[0].text, /floorplanAssetId/);
});

test('Catalogue upload retains conflict semantics and denies missing owner before storage', async () => {
  const foreign = harness({ 'demo-media-object-preflight-create-catering_item': { rowCount: 0, rows: [] } });
  assert.equal(await foreign.catalogue.create(catalogueUpload), null);
  assert.equal(foreign.events.some(Array.isArray), false);
  const conflict = harness({ 'demo-media-object-preflight-existing': { rowCount: 1, rows: [{}] } });
  assert.deepEqual(await conflict.catalogue.create(catalogueUpload), { conflict: true });
  assert.equal(conflict.events.some(Array.isArray), false);
  const valid = harness();
  await valid.catalogue.create(catalogueUpload);
  const insert = valid.events.find((event) => event?.name === 'demo-customer-media-create');
  assert.equal(insert.values[4], null);
  assert.equal(insert.values[10], valid.events.find((event) => event[0] === 'put')[1].key);
  assert.equal(valid.events.at(-1), 'COMMIT');
});

test('Catalogue replacement fails closed on deleted ownership before upload and preserves immutable revision keys', async () => {
  const replacement = { tenantId: TENANT, assetId: ASSET, actorUserId: USER,
    bytes, contentType: 'image/webp', auditEvent: () => ({}) };
  const removed = harness({ 'demo-media-object-replace-owner-lock': { rowCount: 0, rows: [] } });
  assert.equal(await removed.catalogue.replace(replacement), null);
  assert.equal(removed.events.some((event) => event[0] === 'put'), false);
  const valid = harness();
  assert.equal((await valid.catalogue.replace(replacement)).sha256, sha256);
  const update = valid.events.find((event) => event?.name === 'demo-customer-media-replace');
  assert.equal(update.values[2], null);
  assert.equal(update.values[6], `v1/${TENANT}/catalogue/${ASSET}/${sha256}`);
});

test('private media failures have one presentation-safe availability response', () => {
  for (const code of ['MEDIA_STORAGE_UNAVAILABLE', 'MEDIA_STORAGE_INTEGRITY_FAILED', 'MEDIA_STORAGE_BACKFILL_REQUIRED']) {
    const publicError = asApiError(new MediaObjectStorageError(code));
    assert.equal(publicError.statusCode, 503);
    assert.equal(publicError.code, 'ROOM_MEDIA_UNAVAILABLE');
    assert.equal(publicError.context, null);
  }
});
