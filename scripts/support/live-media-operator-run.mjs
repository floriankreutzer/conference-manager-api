import { verifyMediaObjectBytes } from '../../src/media/object-storage-contract.js';
import { exactKeys, LIVE_MEDIA_LIMITS, requireLiveMedia, requireLiveMediaReserve } from './live-media-operator-config.mjs';

export function parseLiveMediaBatch(raw, operation) {
  let value;
  try { value = JSON.parse(raw); } catch { requireLiveMedia(false, 'LIVE_MEDIA_BATCH_OUTCOME_UNKNOWN'); }
  const integers = ['inspected', 'changed', 'byteLength'];
  requireLiveMedia(exactKeys(value, ['status', 'phase', 'kind', ...integers, 'hasMore', 'restoreEvidenceSha256'])
    && value.phase === operation.action && value.kind === operation.kind && value.restoreEvidenceSha256 === null
    && typeof value.hasMore === 'boolean' && value.status === (value.hasMore ? 'incomplete' : 'completed')
    && integers.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && value.inspected <= 10 && value.changed <= value.inspected && value.byteLength <= 20 * 1024 * 1024,
  'LIVE_MEDIA_BATCH_OUTCOME_UNKNOWN');
  return value;
}

function summary(inventory) {
  return Object.fromEntries(['manifestSha256', 'room', 'catalogue', 'bytes', 'postgresOnly',
    'external', 'postgresBytes', 'invalidPostgresBytes', 'otherCustody'].map((key) => [key, inventory[key]]));
}

export function initialLiveMediaReport(operation) {
  return { schemaVersion: 1, operationId: operation.record.operationId, recordSha256: operation.recordSha256,
    sourceSha: operation.record.sourceSha, controllerSha: operation.controllerSha,
    runId: operation.runId, action: operation.action, kind: operation.kind,
    projectId: operation.record.projectId, branchId: operation.record.branchId,
    databaseEndpointId: operation.record.databaseEndpointId, expiresAt: operation.record.expiresAt,
    externalEvidenceSha256: operation.record.externalEvidenceSha256, recoveryEvidenceSha256: operation.record.recoveryEvidenceSha256,
    status: 'not_started', mutationOutcome: 'not_started', complete: false, providerReads: 0,
    providerReadVerified: false };
}

// Ports are supplied only by the fixed entry point. No dispatch input can supply
// SQL, shell commands, network destinations, test fixtures or alternative adapters.
export async function runLiveMediaOperation(operation, ports, report = initialLiveMediaReport(operation)) {
  const reserve = (milliseconds = LIVE_MEDIA_LIMITS.finishReserveMs) => {
    requireLiveMediaReserve(operation, ports.now(), milliseconds);
    requireLiveMedia(ports.now() + milliseconds < ports.processDeadline, 'LIVE_MEDIA_RUN_DEADLINE');
  };
  const boundary = async () => {
    reserve();
    await ports.closed();
    await ports.quiescent();
  };
  const verifyObjects = async (inventory) => {
    for (const item of inventory.references) {
      if (item.objectKey === null) continue;
      reserve(20_000);
      verifyMediaObjectBytes(await ports.get(item.reference), item.reference);
      report.providerReads += 1;
      report.providerReadVerified = true;
    }
  };
  const manifest = (inventory) => requireLiveMedia(inventory.manifestSha256 === operation.record.manifestSha256,
    'LIVE_MEDIA_INVENTORY_CHANGED');
  try {
    reserve();
    await ports.identity();
    if (operation.action !== 'preflight') await boundary();
    const before = await ports.inventory();
    report.before = summary(before);
    requireLiveMedia(before.references.every((item) => item.objectKey !== null && operation.record.direction === 'rollback'
      || item.hasBytes && item.bytesValid), 'LIVE_MEDIA_POSTGRES_BYTES_INVALID');
    if (operation.action === 'preflight') {
      await verifyObjects(before);
      reserve();
      report.status = 'preflight_only';
      return report;
    }
    manifest(before);
    if (['copy', 'rollback'].includes(operation.action)) {
      // A previous invocation with an unknown outcome is reconciled by the owner
      // before another dispatch. This invocation never retries or drains batches.
      reserve(LIVE_MEDIA_LIMITS.batchMs + LIVE_MEDIA_LIMITS.finishReserveMs);
      await boundary();
      reserve(LIVE_MEDIA_LIMITS.batchMs + LIVE_MEDIA_LIMITS.finishReserveMs);
      report.mutationOutcome = 'unknown';
      report.status = 'batch_in_progress';
      ports.persist(report);
      report.batch = parseLiveMediaBatch(await ports.batch(), operation);
      report.mutationOutcome = 'observed';
    }
    await boundary();
    const after = await ports.inventory();
    report.after = summary(after);
    manifest(after);
    requireLiveMedia(after.references.every((item) => item.objectKey !== null && operation.record.direction === 'rollback'
      || item.hasBytes && item.bytesValid), 'LIVE_MEDIA_POSTGRES_BYTES_INVALID');
    await verifyObjects(after);
    if (operation.record.direction === 'rollback' && operation.action === 'reconcile' && after.external === 0) {
      requireLiveMedia(after.references.every((item) => item.hasBytes && item.bytesValid), 'LIVE_MEDIA_ROLLBACK_BYTES_MISSING');
    }
    await boundary();
    const final = await ports.inventory();
    requireLiveMedia(JSON.stringify(summary(final)) === JSON.stringify(summary(after)), 'LIVE_MEDIA_INVENTORY_CHANGED');
    reserve();
    // A successful batch is never the final approval to open either service.
    // Only this full read-only reconciliation can establish the requested state.
    report.complete = operation.action === 'reconcile'
      && (operation.record.direction === 'copy' ? after.postgresOnly === 0 : after.external === 0);
    report.status = report.complete ? 'reconciled' : 'incomplete';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.complete = false;
    const allowed = new Set(['LIVE_MEDIA_BATCH_OUTCOME_UNKNOWN', 'LIVE_MEDIA_RUN_DEADLINE', 'LIVE_MEDIA_DEADLINE_EXPIRED',
      'LIVE_MEDIA_INVENTORY_CHANGED', 'LIVE_MEDIA_POSTGRES_BYTES_INVALID', 'LIVE_MEDIA_ROLLBACK_BYTES_MISSING',
      'LIVE_MEDIA_DATABASE_NOT_QUIESCENT', 'LIVE_MEDIA_IDENTITY_INVALID', 'LIVE_MEDIA_INVENTORY_INVALID', 'LIVE_MEDIA_RUNTIME_NOT_CLOSED']);
    report.code = allowed.has(error?.code) ? error.code : 'LIVE_MEDIA_FAILED';
    return report;
  }
}
