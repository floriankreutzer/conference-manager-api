import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mediaObjectReference } from '../src/media/object-storage-contract.js';
import { runDemoCopyDiscard, DemoCopyDiscardFailure } from '../scripts/support/demo-copy-discard-run.mjs';

const bytes = Buffer.from('verified current Demo object');
const manifest = 'b'.repeat(64);
const now = Date.parse('2026-10-16T05:00:00.000Z');
const context = { action: 'discard', kind: 'room', expiresAt: now + 20 * 60000,
  sourceSha: 'a'.repeat(40), runId: '123', expectedManifestSha256: manifest };
function fixture() {
  let discarded = false;
  let reads = 0;
  let batches = 0;
  const refs = ['room', 'catalogue'].map((kind, index) => mediaObjectReference({
    tenantId: '11111111-1111-4111-8111-111111111111',
    assetId: `22222222-2222-4222-8222-22222222222${index + 2}`, kind,
    contentType: 'image/webp', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const receipt = { status: 'completed', phase: 'discard-demo-copy', kind: 'room', inspected: 1,
    changed: 1, byteLength: bytes.length, hasMore: false, restoreEvidenceSha256: null,
    demoDataDiscardDecision: 'saas38-pre-pilot-demo-only' };
  const ports = {
    clock: () => now,
    async readInventory() {
      return { room: 1, catalogue: 1, bytes: bytes.length * 2, external: 2, postgresOnly: 0,
        postgresBytes: discarded ? 1 : 2, invalidPostgresBytes: 0, otherCustody: 0, manifestSha256: manifest,
        references: refs.map((reference) => ({ reference, hasBytes: !discarded || reference.kind === 'catalogue' })) };
    },
    async readObject() { reads += 1; return bytes; },
    async discardBatch(kind) { assert.equal(kind, 'room'); batches += 1; discarded = true; return receipt; },
  };
  return { ports, receipt, get reads() { return reads; }, get batches() { return batches; } };
}

test('manual Demo preflight is read-only and one discard reconciles both kinds and all verified objects', async () => {
  const state = fixture();
  const preflight = await runDemoCopyDiscard({ ...context, action: 'preflight', kind: 'none' }, state.ports);
  assert.equal(preflight.status, 'preflight_verified');
  assert.equal(state.batches, 0);
  assert.equal(state.reads, 2);
  const result = await runDemoCopyDiscard(context, state.ports);
  assert.equal(result.status, 'batch_verified');
  assert.equal(state.batches, 1);
  assert.equal(state.reads, 6);
  assert.equal(result.before.retainedRoom, 1);
  assert.equal(result.after.retainedRoom, 0);
  assert.equal(result.after.retainedCatalogue, 1);
  assert.equal(result.before.manifestSha256, result.after.manifestSha256);
  assert.equal(JSON.stringify(result).includes('tenantId'), false);
  assert.equal(JSON.stringify(result).includes('object_key'), false);
});

test('stale manifests, unavailable objects and consumed deadline reserve prevent any discard', async () => {
  for (const mode of ['manifest', 'provider', 'deadline']) {
    const state = fixture();
    let clock = now;
    const ports = { ...state.ports, clock: () => clock };
    if (mode === 'provider') ports.readObject = async () => Buffer.from('corrupt');
    if (mode === 'deadline') ports.readObject = async () => { clock = now + 70000; return bytes; };
    await assert.rejects(runDemoCopyDiscard({ ...context,
      expectedManifestSha256: mode === 'manifest' ? 'c'.repeat(64) : manifest }, ports), DemoCopyDiscardFailure);
    assert.equal(state.batches, 0);
  }
});

test('post-mutation content/metadata or wrong-count failures cannot become successful receipts', async () => {
  for (const mode of ['provider', 'manifest', 'count', 'kind']) {
    const state = fixture();
    let mutated = false;
    const ports = { ...state.ports,
      async discardBatch(kind) { mutated = true; return state.ports.discardBatch(kind); },
      async readObject() { return mutated && mode === 'provider' ? Buffer.from('corrupt') : bytes; },
      async readInventory() {
        const data = await state.ports.readInventory();
        if (mutated && mode === 'manifest') data.manifestSha256 = 'c'.repeat(64);
        if (mutated && mode === 'count') { data.postgresBytes = 2; data.references[0].hasBytes = true; }
        return data;
      },
    };
    if (mode === 'kind') ports.discardBatch = async () => ({ ...state.receipt, kind: 'catalogue' });
    await assert.rejects(runDemoCopyDiscard(context, ports), (error) => {
      assert.equal(error.message, 'DEMO_COPY_DISCARD_EXECUTION_FAILED');
      assert.equal(error.before.manifestSha256, manifest);
      assert.equal(error.receipt?.changed ?? null, mode === 'kind' ? null : 1);
      return true;
    });
  }
});

test('malformed child output cannot leak through the minimized failure evidence', async () => {
  const state = fixture();
  await assert.rejects(runDemoCopyDiscard(context, { ...state.ports,
    async discardBatch() { return { ...state.receipt, privateProviderPayload: 'must-never-leak' }; },
  }), (error) => {
    assert.equal(error.receipt, null);
    assert.equal(JSON.stringify(error).includes('must-never-leak'), false);
    return true;
  });
  await assert.rejects(runDemoCopyDiscard(context, { ...state.ports, clock: () => NaN }), DemoCopyDiscardFailure);
});
