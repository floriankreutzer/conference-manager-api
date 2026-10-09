import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DEMO_FIXTURE, DEMO_FIXTURE_CHECKSUM, createDemoResetGenerationFixture, semanticChecksum } from '../src/demo/fixture.js';
import { demoFixtureMediaReferences } from '../src/persistence/postgres/demo-fixture-media.js';
import { restoredMediaReferences, verifyRestoredProviderBytes, verifyRestoredSemanticState } from '../scripts/support/neon-recovery-media.mjs';
import { RECOVERY_MANIFEST } from '../scripts/support/neon-recovery-config.mjs';

const references = [...demoFixtureMediaReferences(DEMO_FIXTURE)].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const rows = references.map((r) => ({ tenant_id: r.tenantId, id: r.assetId, kind: r.kind,
  content_type: r.contentType, byte_length: r.byteLength, sha256: r.sha256, object_key: r.key, blob_valid: true,
  inventory_key: r.key, inventory_length: r.byteLength, inventory_sha256: r.sha256,
  inventory_type: r.contentType, inventory_tenant: r.tenantId, inventory_asset: r.assetId, inventory_kind: r.kind }));

test('restored business state must match the canonical seed or its supported dated reset generation before reset', () => {
  assert.equal(verifyRestoredSemanticState(DEMO_FIXTURE), DEMO_FIXTURE_CHECKSUM);
  const generation = createDemoResetGenerationFixture(DEMO_FIXTURE, new Date('2026-10-09T20:00:00Z'));
  assert.equal(verifyRestoredSemanticState(generation), semanticChecksum(generation));
  for (const fixture of [DEMO_FIXTURE, generation]) {
    const changed = structuredClone(fixture);
    changed.tenants[0].displayName = 'Damaged restoration';
    assert.throws(() => verifyRestoredSemanticState(changed));
  }
  assert.throws(() => verifyRestoredSemanticState({ ...generation, fixedClock: 'invalid' }));
});

test('restored preflight binds all 34 canonical revisions to retained DB blobs and inventory custody', () => {
  const result = restoredMediaReferences(rows);
  assert.equal(result.digest, RECOVERY_MANIFEST);
  assert.equal(result.manifest.reduce((sum, row) => sum + row.size, 0), 5192696);
  for (const change of [{ blob_valid: null }, { blob_valid: false }, { object_key: 'foreign-key' },
    { inventory_key: null }, { inventory_tenant: DEMO_FIXTURE.tenants[1].id },
    { inventory_asset: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, { inventory_length: 1 },
    { inventory_sha256: 'a'.repeat(64) }, { inventory_type: 'image/png' }, { inventory_kind: 'room' }]) {
    const index = rows.findIndex(({ kind, content_type }) => kind === 'catalogue' && content_type === 'image/webp');
    assert.throws(() => restoredMediaReferences(rows.map((row, i) => i === index ? { ...row, ...change } : row)));
  }
  assert.throws(() => restoredMediaReferences(rows.slice(1)));
  assert.throws(() => restoredMediaReferences([...rows, rows[0]]));
  assert.throws(() => restoredMediaReferences(rows.map((row, i) => i === 0 ? rows[1] : row)));
});

test('independent provider readback verifies every canonical byte without fallback or unbounded concurrency', async () => {
  const directory = new URL('../src/demo/media/', import.meta.url);
  const bytesByHash = new Map();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.b64')) continue;
    const bytes = Buffer.from((await readFile(new URL(name, directory), 'utf8')).trim(), 'base64');
    bytesByHash.set(createHash('sha256').update(bytes).digest('hex'), bytes);
  }
  const seen = [];
  let active = 0;
  let peak = 0;
  await verifyRestoredProviderBytes({ async get(reference) {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(reference.key);
    active -= 1;
    return bytesByHash.get(reference.sha256);
  } }, references);
  assert.deepEqual(seen.sort(), references.map(({ key }) => key));
  assert.equal(peak, 4);
  assert.equal(active, 0);
  for (const get of [async () => Buffer.from('corrupt'), async () => { throw new Error('MEDIA_STORAGE_OBJECT_MISSING'); }]) {
    let calls = 0;
    await assert.rejects(verifyRestoredProviderBytes({ async get(r) { calls += 1; return get(r); } }, references));
    assert.equal(calls, 4);
  }
});
