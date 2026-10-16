import { verifyMediaObjectBytes } from '../../src/media/object-storage-contract.js';
import { exactKeys } from './live-media-operator-config.mjs';

export class DemoCopyDiscardFailure extends Error {
  constructor(before, receipt) {
    super('DEMO_COPY_DISCARD_EXECUTION_FAILED');
    this.before = before;
    this.receipt = receipt;
  }
}

function summary(value) {
  const fields = ['room', 'catalogue', 'bytes', 'external', 'postgresOnly', 'postgresBytes',
    'invalidPostgresBytes', 'otherCustody'];
  if (!value || fields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || !Array.isArray(value.references) || value.references.length > 1000 || value.bytes > 128 * 1024 * 1024
    || value.postgresOnly !== 0 || value.invalidPostgresBytes !== 0 || value.external !== value.references.length
    || value.room + value.catalogue !== value.external || value.postgresBytes > value.external
    || value.references.some((row) => typeof row.hasBytes !== 'boolean')
    || !/^[a-f0-9]{64}$/.test(value.manifestSha256 || '')) throw new Error('DEMO_COPY_INVENTORY_INVALID');
  const retained = (kind) => value.references.filter((row) => row.reference.kind === kind && row.hasBytes).length;
  const result = { ...Object.fromEntries(fields.map((key) => [key, value[key]])),
    manifestSha256: value.manifestSha256, retainedRoom: retained('room'), retainedCatalogue: retained('catalogue') };
  if (result.retainedRoom + result.retainedCatalogue !== result.postgresBytes) throw new Error('DEMO_COPY_INVENTORY_INVALID');
  return result;
}

function validateReceipt(value, kind) {
  if (!exactKeys(value, ['status', 'phase', 'kind', 'inspected', 'changed', 'byteLength', 'hasMore',
    'restoreEvidenceSha256', 'demoDataDiscardDecision']) || value.phase !== 'discard-demo-copy' || value.kind !== kind
    || !['completed', 'incomplete'].includes(value.status) || typeof value.hasMore !== 'boolean'
    || value.status !== (value.hasMore ? 'incomplete' : 'completed') || value.restoreEvidenceSha256 !== null
    || value.demoDataDiscardDecision !== 'saas38-pre-pilot-demo-only'
    || !Number.isSafeInteger(value.inspected) || value.inspected < 0 || value.inspected > 10
    || !Number.isSafeInteger(value.changed) || value.changed < 0 || value.changed > value.inspected
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < value.changed
    || value.byteLength > value.changed * 2097152) throw new Error('DEMO_COPY_RECEIPT_INVALID');
  return value;
}

// IO ports are supplied only by the reviewed manual operator entrypoint. The
// core verifies every provider read and reconciles each mutation before success.
export async function runDemoCopyDiscard(context, { readInventory, readObject, discardBatch, clock = Date.now }) {
  let before = null;
  let receipt = null;
  let lastClock = clock();
  if (!Number.isSafeInteger(lastClock) || !Number.isSafeInteger(context.expiresAt)) {
    throw new DemoCopyDiscardFailure(null, null);
  }
  const deadline = Math.min(context.expiresAt, lastClock + 180000);
  function reserve(milliseconds = 15000) {
    const time = clock();
    if (!Number.isSafeInteger(time) || time < lastClock || time + milliseconds >= deadline) {
      throw new Error('DEMO_COPY_EXECUTION_EXPIRED');
    }
    lastClock = time;
  }
  async function inventory() {
    reserve();
    const value = await readInventory();
    const result = summary(value);
    for (let index = 0; index < value.references.length; index += 4) {
      reserve();
      const results = await Promise.allSettled(value.references.slice(index, index + 4).map(async ({ reference }) =>
        verifyMediaObjectBytes(await readObject(reference), reference)));
      if (results.some((row) => row.status !== 'fulfilled')) throw new Error('DEMO_COPY_PROVIDER_VERIFICATION_FAILED');
    }
    return result;
  }
  try {
    before = await inventory();
    if (context.action === 'discard') {
      if (before.manifestSha256 !== context.expectedManifestSha256) throw new Error('DEMO_COPY_MANIFEST_CHANGED');
      reserve(120000);
      receipt = validateReceipt(await discardBatch(context.kind), context.kind);
    }
    const after = context.action === 'discard' ? await inventory() : before;
    if (['manifestSha256', 'bytes', 'room', 'catalogue', 'otherCustody', 'external']
      .some((key) => after[key] !== before[key])
      || after.postgresBytes !== before.postgresBytes - (receipt?.changed || 0)
      || after.retainedRoom !== before.retainedRoom - (receipt?.kind === 'room' ? receipt.changed : 0)
      || after.retainedCatalogue !== before.retainedCatalogue - (receipt?.kind === 'catalogue' ? receipt.changed : 0)) {
      throw new Error('DEMO_COPY_RECONCILIATION_FAILED');
    }
    reserve(0);
    return { status: context.action === 'preflight' ? 'preflight_verified' : 'batch_verified',
      sourceSha: context.sourceSha, runId: context.runId, action: context.action, kind: context.kind,
      observedAt: new Date(clock()).toISOString(), expiresAt: new Date(context.expiresAt).toISOString(),
      before, receipt, after };
  } catch { throw new DemoCopyDiscardFailure(before, receipt); }
}
