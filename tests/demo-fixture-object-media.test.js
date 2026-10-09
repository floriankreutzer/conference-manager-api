import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEMO_FIXTURE } from '../src/demo/fixture.js';
import { forEachDemoMediaBatch, demoFixtureMediaReferences, publishDemoFixtureMedia,
  readDemoFixtureMediaBytes } from '../src/persistence/postgres/demo-fixture-media.js';
import { seedDemoBusinessState } from '../src/persistence/postgres/demo-fixture-state.js';

test('canonical media intents are Tenant/kind/content bound and external seeding stores metadata only', async () => {
  const references = demoFixtureMediaReferences(DEMO_FIXTURE);
  assert.equal(references.length, 34);
  assert.equal(references.filter(({ kind }) => kind === 'room').length, 11);
  assert.equal(references.filter(({ kind }) => kind === 'catalogue').length, 23);
  const queries = [];
  const uploaded = [];
  let active = 0;
  let peak = 0;
  const client = { async query(query) {
    queries.push(query);
    return { rowCount: 1, rows: query.name === 'demo-fixture-projection-clock' ? [{ observed_at: new Date() }] : [] };
  } };
  await seedDemoBusinessState({ client,
    fixture: { ...DEMO_FIXTURE, tenants: DEMO_FIXTURE.tenants.map((tenant) => ({ ...tenant, requests: [] })) },
    refreshProjections: async () => ({ refreshedCount: 3 }),
    mediaObjects: { async putWithClient(actualClient, reference, bytes) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(actualClient, client);
      assert.equal(bytes.length, reference.byteLength);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
      uploaded.push(reference);
      active -= 1;
      return reference.key;
    } },
  });
  assert.deepEqual(uploaded.map(({ key }) => key).sort(), references.map(({ key }) => key).sort());
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(active, 0);
  const room = queries.filter(({ name }) => name === 'demo-fixture-insert-room-media');
  const catalogue = queries.filter(({ name }) => name === 'demo-fixture-insert-catalogue-media');
  assert.equal(room.every(({ values }) => values[3] === null && values[10].startsWith(`v1/${values[0]}/room/`)), true);
  assert.equal(catalogue.every(({ values }) => values[4] === null && values[11].startsWith(`v1/${values[0]}/catalogue/`)), true);
});

test('Demo media batches drain in-flight work before failure and never dispatch the next batch', async () => {
  const started = [];
  const pending = [];
  const failure = new Error('MEDIA_STORAGE_UNAVAILABLE');
  let finished = false;
  const result = forEachDemoMediaBatch([0, 1, 2, 3, 4, 5], (item) => {
    started.push(item);
    if (item === 0) throw failure;
    return new Promise((resolve) => pending.push(resolve));
  }).finally(() => { finished = true; });
  const rejected = assert.rejects(result, (error) => error === failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.equal(finished, false);
  for (const resolve of pending) resolve();
  await rejected;
  assert.equal(finished, true);
  assert.deepEqual(started, [0, 1, 2, 3]);
});

test('Demo media batches process every tail item and reject malformed contracts before work', async () => {
  const processed = [];
  await forEachDemoMediaBatch([0, 1, 2, 3, 4, 5, 6, 7, 8], async (item) => { processed.push(item); });
  assert.deepEqual(processed, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  await forEachDemoMediaBatch([], () => { throw new Error('UNEXPECTED_WORK'); });
  await assert.rejects(forEachDemoMediaBatch(null, () => {}), { message: 'DEMO_MEDIA_BATCH_INVALID' });
  await assert.rejects(forEachDemoMediaBatch([], null), { message: 'DEMO_MEDIA_BATCH_INVALID' });
});

test('semantic object reads reject foreign keys, missing ports, unbackfilled data and corrupt provider bytes', async () => {
  const reference = demoFixtureMediaReferences(DEMO_FIXTURE)[0];
  const bytes = Buffer.from('corrupt bytes');
  const row = { tenant_id: reference.tenantId, id: reference.assetId, content_type: reference.contentType,
    byte_length: reference.byteLength, content_sha256: Buffer.from(reference.sha256, 'hex'), object_key: reference.key };
  let calls = 0;
  const mediaObjects = { async read() { calls += 1; return bytes; } };
  await assert.rejects(readDemoFixtureMediaBytes({ ...row, object_key: reference.key.replace('/room/', '/catalogue/') },
    'room', mediaObjects), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal(calls, 0);
  await assert.rejects(readDemoFixtureMediaBytes(row, 'room', null), { code: 'MEDIA_STORAGE_UNAVAILABLE' });
  await assert.rejects(readDemoFixtureMediaBytes({ ...row, object_key: null, bytes }, 'room', mediaObjects),
    { code: 'MEDIA_STORAGE_BACKFILL_REQUIRED' });
  assert.equal(calls, 0);
  await assert.rejects(readDemoFixtureMediaBytes(row, 'room', mediaObjects), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  assert.equal(calls, 1);
});

test('external seed rejects an adapter returning a noncanonical publication key', async () => {
  const tenant = DEMO_FIXTURE.tenants[0];
  const media = tenant.roomMedia[0];
  await assert.rejects(publishDemoFixtureMedia({}, tenant.id, media, 'room', Buffer.alloc(media.byteLength),
    { async putWithClient() { throw new Error('SHOULD_NOT_REACH_PROVIDER'); } }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
  const roomNumber = media.roomId.slice('northwind-berlin-room-'.length).padStart(2, '0');
  const encoded = await readFile(new URL(`../src/demo/media/northwind-room-${roomNumber}.webp.b64`, import.meta.url), 'utf8');
  await assert.rejects(publishDemoFixtureMedia({}, tenant.id, media, 'room', Buffer.from(encoded.trim(), 'base64'),
    { async putWithClient() { return 'foreign-key'; } }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
});
