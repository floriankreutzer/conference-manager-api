import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPostgresMediaBackfillRepository,
  createPostgresDemoMediaCopyDiscardRepository } from '../src/persistence/postgres/media-backfill-repository.js';

const bytes = Buffer.from('retained verified bytes');
const digest = createHash('sha256').update(bytes).digest();
const tenantId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const key = `v1/${tenantId}/room/${assetId}/${digest.toString('hex')}`;
const evidence = 'a'.repeat(64);
const row = { tenant_id: tenantId, id: assetId, content_type: 'image/webp',
  byte_length: bytes.length, content_sha256: digest, bytes, object_key: key };

function setup({ locked = row, restored = bytes, failure = false, includeDemoCatalogue = false,
  demoDiscard = false, identity = { database: 'conference_manager_demo_shared', role: 'cm_demo_migration',
    schema_version: 71, overlay_version: 31, sentinel_count: '1' } } = {}) {
  const events = [];
  const query = async (input) => {
    events.push(input);
    if (input?.name === 'media-demo-copy-discard-authority') return { rowCount: identity ? 1 : 0, rows: identity ? [identity] : [] };
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
  return { events, repository: demoDiscard
    ? createPostgresDemoMediaCopyDiscardRepository(pool, { mediaObjects })
    : createPostgresMediaBackfillRepository(pool, { mediaObjects, includeDemoCatalogue }) };
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

test('Demo discard is a distinct port and cannot replace ordinary restore-bound purge', async () => {
  const normal = setup();
  await assert.rejects(normal.repository.runBatch({ phase: 'discard-demo-copy', kind: 'room' }), /INPUT_INVALID/);
  await assert.rejects(normal.repository.runBatch({ phase: 'purge', kind: 'room' }), /RESTORE_EVIDENCE_REQUIRED/);
  assert.deepEqual(normal.events, []);
  const demo = setup({ demoDiscard: true });
  assert.equal(demo.repository.runBatch, undefined);
  const result = await demo.repository.discardBatch({ kind: 'room' });
  assert.equal(result.phase, 'discard-demo-copy');
  assert.equal(result.changed, 1);
  const update = demo.events.find((event) => event?.name === 'media-backfill-discard-demo-copy-room');
  assert.match(update.text, /SET bytes = NULL/);
  assert.deepEqual(update.values, [tenantId, assetId]);
  assert.equal(demo.events.some((event) => Array.isArray(event) && event[0] !== 'read'), false);
  assert.equal(demo.events.some((event) => /DELETE|SET object_key|media_object_inventory/.test(event?.text || '')), false);
});

test('Demo discard rejects non-Demo identity and unknown schema before candidates or provider access', async () => {
  const valid = { database: 'conference_manager_demo_shared', role: 'cm_demo_migration',
    schema_version: 71, overlay_version: 31, sentinel_count: '1' };
  for (const identity of [null, ...[{ database: 'production' }, { role: 'cm_demo_customer' },
    { schema_version: 45 }, { schema_version: 46 }, { schema_version: 47 }, { schema_version: 48 },
    { schema_version: 49 }, { schema_version: 50 }, { schema_version: 51 }, { schema_version: 52 },
    { schema_version: 53 }, { schema_version: 54 }, { schema_version: 55 }, { schema_version: 56 }, { schema_version: 57 },
    { schema_version: 58 }, { schema_version: 59 }, { schema_version: 60 }, { schema_version: 61 }, { schema_version: 62 },
    { schema_version: 63 }, { schema_version: 64 }, { schema_version: 65 }, { schema_version: 66 }, { schema_version: 67 },
    { schema_version: 68 }, { schema_version: 69 }, { schema_version: 70 }, { schema_version: 72 },
    { overlay_version: 8 }, { overlay_version: 11 },
    { overlay_version: 12 }, { overlay_version: 13 }, { overlay_version: 14 }, { overlay_version: 15 },
    { overlay_version: 16 }, { overlay_version: 17 }, { overlay_version: 18 }, { overlay_version: 19 },
    { overlay_version: 20 }, { overlay_version: 21 }, { overlay_version: 22 }, { overlay_version: 23 },
    { overlay_version: 24 }, { overlay_version: 25 }, { overlay_version: 26 }, { overlay_version: 27 },
    { overlay_version: 28 }, { overlay_version: 29 }, { overlay_version: 30 }, { overlay_version: 32 },
    { sentinel_count: '0' }, { sentinel_count: '2' }]
    .map((change) => ({ ...valid, ...change }))]) {
    const state = setup({ demoDiscard: true, identity });
    await assert.rejects(state.repository.discardBatch({ kind: 'room' }), /DEMO_COPY_DISCARD_AUTHORITY_REQUIRED/);
    assert.equal(state.events.length, 1);
  }
});

test('Demo discard retains integrity and race checks and never clears a wrong or corrupt copy', async () => {
  for (const change of [{ restored: Buffer.from('corrupt') }, { locked: { ...row, bytes: Buffer.from('corrupt') } },
    { locked: { ...row, object_key: key.replace(tenantId, assetId) } }]) {
    const state = setup({ demoDiscard: true, ...change });
    await assert.rejects(state.repository.discardBatch({ kind: 'room' }), { code: 'MEDIA_STORAGE_INTEGRITY_FAILED' });
    assert.equal(state.events.at(-1), 'ROLLBACK');
    assert.equal(state.events.some((event) => event?.name === 'media-backfill-discard-demo-copy-room'), false);
  }
  const state = setup({ demoDiscard: true, locked: null });
  assert.equal((await state.repository.discardBatch({ kind: 'room' })).changed, 0);
  assert.equal(state.events.some(Array.isArray), false);
  for (const input of [{ kind: 'unknown' }, { kind: 'room', limit: 11 }]) {
    await assert.rejects(state.repository.discardBatch(input), /INPUT_INVALID/);
  }
});

test('Demo discard CLI requires its exact owner decision and fixed target without leaking malformed credentials', () => {
  const script = new URL('../scripts/private-media-migration.mjs', import.meta.url);
  for (const args of [['--execute', 'discard-demo-copy', 'room'],
    ['--execute', 'discard-demo-copy', 'room', '--demo-data-discard=production'],
    ['--execute', 'purge', 'room', '--demo-data-discard=saas38-pre-pilot-demo-only']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8', env: {} });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MEDIA_MIGRATION_EXECUTE_CONTRACT_REQUIRED/);
    assert.equal(result.stdout, '');
  }
  for (const databaseUrl of ['malformed-private-credential',
    'postgresql://cm_demo_migration:private-credential-must-not-appear@foreign.example/conference_manager_demo_shared']) {
    const result = spawnSync(process.execPath, [script.pathname, '--execute', 'discard-demo-copy', 'room',
      '--demo-data-discard=saas38-pre-pilot-demo-only'], { encoding: 'utf8',
      env: { MEDIA_MIGRATION_DATABASE_URL: databaseUrl, MEDIA_MIGRATION_DATABASE_ROLE: 'cm_demo_migration' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MEDIA_DEMO_COPY_DISCARD_TARGET_REQUIRED/);
    assert.doesNotMatch(result.stderr, /private-credential|foreign\.example/);
    assert.equal(result.stdout, '');
  }
  const operator = { NODE_ENV: 'production', DATABASE_SSL: 'verify-full',
    MEDIA_MIGRATION_DATABASE_URL: `postgresql://cm_demo_migration:${'x'.repeat(32)}`
      + '@ep-solitary-thunder-b1ydpuiq.c-5.eu-central-1.aws.neon.tech/conference_manager_demo_shared',
    MEDIA_MIGRATION_DATABASE_ROLE: 'cm_demo_migration',
    MEDIA_OPERATOR_ENDPOINT: 'https://br-summer-rice-b1f8voyp.storage.c-5.eu-central-1.aws.neon.tech',
    MEDIA_OPERATOR_REGION: 'eu-central-1', MEDIA_OPERATOR_BUCKET: 'conference-manager-media',
    MEDIA_OPERATOR_ACCESS_KEY_ID: 'synthetic-access-id', MEDIA_OPERATOR_SECRET_ACCESS_KEY: 'x'.repeat(32) };
  for (const change of [
    { MEDIA_OPERATOR_ENDPOINT: 'https://br-staging-example.storage.c-5.eu-central-1.aws.neon.tech' },
    { MEDIA_OPERATOR_BUCKET: 'staging-media' },
  ]) {
    const result = spawnSync(process.execPath, [script.pathname, '--execute', 'discard-demo-copy', 'room',
      '--demo-data-discard=saas38-pre-pilot-demo-only'], { encoding: 'utf8', env: { ...operator, ...change } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MEDIA_DEMO_COPY_DISCARD_STORAGE_TARGET_REQUIRED/);
    assert.doesNotMatch(result.stderr, /br-staging-example|staging-media|x{32}/);
    assert.equal(result.stdout, '');
  }
});
