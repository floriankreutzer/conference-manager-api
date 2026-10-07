import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEMO_FIXTURE } from '../src/demo/fixture.js';
import { demoFixtureMediaReferences, publishDemoFixtureMedia,
  readDemoFixtureMediaBytes } from '../src/persistence/postgres/demo-fixture-media.js';
import { seedDemoBusinessState } from '../src/persistence/postgres/demo-fixture-state.js';

test('canonical media intents are Tenant/kind/content bound and external seeding stores metadata only', async () => {
  const references = demoFixtureMediaReferences(DEMO_FIXTURE);
  assert.equal(references.length, 34);
  assert.equal(references.filter(({ kind }) => kind === 'room').length, 11);
  assert.equal(references.filter(({ kind }) => kind === 'catalogue').length, 23);
  const queries = [];
  const uploaded = [];
  const client = { async query(query) {
    queries.push(query);
    return { rowCount: 1, rows: query.name === 'demo-fixture-projection-clock' ? [{ observed_at: new Date() }] : [] };
  } };
  await seedDemoBusinessState({ client,
    fixture: { ...DEMO_FIXTURE, tenants: DEMO_FIXTURE.tenants.map((tenant) => ({ ...tenant, requests: [] })) },
    refreshProjections: async () => ({ refreshedCount: 3 }),
    mediaObjects: { async putWithClient(actualClient, reference, bytes) {
      assert.equal(actualClient, client);
      assert.equal(bytes.length, reference.byteLength);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
      uploaded.push(reference);
      return reference.key;
    } },
  });
  assert.deepEqual(uploaded.map(({ key }) => key).sort(), references.map(({ key }) => key).sort());
  const room = queries.filter(({ name }) => name === 'demo-fixture-insert-room-media');
  const catalogue = queries.filter(({ name }) => name === 'demo-fixture-insert-catalogue-media');
  assert.equal(room.every(({ values }) => values[3] === null && values[10].startsWith(`v1/${values[0]}/room/`)), true);
  assert.equal(catalogue.every(({ values }) => values[4] === null && values[11].startsWith(`v1/${values[0]}/catalogue/`)), true);
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
