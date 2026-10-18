import { open } from 'node:fs/promises';
import { loadTargetScope } from './target-load-guard.mjs';

const KINDS = new Set(['session_read', 'room_page_read', 'media_read', 'availability_lookup', 'request_create',
  'request_read', 'request_transition', 'observer_read', 'observer_cold_read',
  'negative_foreign_read', 'negative_missing_csrf', 'negative_stale_version']);
const FIELDS = ['ordinal', 'surface', 'kind', 'method', 'responseByteReservation', 'requestPayloadBytes'];
function valid(value) { if (!value) throw new Error('LOAD_TARGET_JOURNAL_FAILED'); }

// One controller/host owns one run journal. Exclusive creation deliberately forbids
// resuming or restarting a failed campaign. Reservations survive process failure;
// this local journal is not a provider-enforced or multi-host spending limit.
export async function createTargetLoadJournal(values, { clock = Date.now } = {}) {
  let file;
  try {
    const scope = loadTargetScope(values, clock()); valid(scope.surface === 'setup');
    const path = `/tmp/cm-saas38-load-${scope.runId}-campaign.ndjson`;
    file = await open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify({ schemaVersion: 1, runId: scope.runId, releaseSha: scope.releaseSha,
      createdAt: scope.createdAt, expiresAt: scope.expiresAt })}\n`); await file.sync();
    let closed = false; let failed = false; let count = 0; let responseBytes = 0; let previous = clock();
    let writes = Promise.resolve();
    async function reserve(row) {
      try {
        const now = clock();
        valid(!closed && !failed && Number.isSafeInteger(now) && now >= previous && now < scope.expiresMs - 60_000);
        previous = now;
        valid(row && typeof row === 'object' && !Array.isArray(row)
          && Object.keys(row).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(row, key)));
        valid(row.ordinal === count + 1 && row.ordinal <= 10_000 && ['customer', 'platform'].includes(row.surface)
          && KINDS.has(row.kind) && ['GET', 'POST'].includes(row.method));
        valid(row.surface === 'customer' || ['observer_read', 'observer_cold_read'].includes(row.kind));
        const writes = ['availability_lookup', 'request_create', 'request_transition', 'negative_missing_csrf', 'negative_stale_version'];
        valid(row.method === (writes.includes(row.kind) ? 'POST' : 'GET'));
        valid(row.responseByteReservation === (row.kind === 'media_read' ? 2 * 1024 * 1024 : 8192));
        valid(Number.isSafeInteger(row.requestPayloadBytes) && row.requestPayloadBytes >= 0 && row.requestPayloadBytes <= 8192
          && (row.method === 'POST' || row.requestPayloadBytes === 0));
        valid(responseBytes + row.responseByteReservation <= 2_000_000_000);
        const checked = Object.fromEntries(FIELDS.map(key => [key, row[key]]));
        await file.write(`${JSON.stringify(checked)}\n`); await file.sync();
        valid(clock() >= now && clock() < scope.expiresMs - 60_000);
        count += 1; responseBytes += row.responseByteReservation;
      } catch { failed = true; throw new Error('LOAD_TARGET_JOURNAL_FAILED'); }
    }
    return Object.freeze({
      recordAttempt(row) {
        // Copy before entering the async queue, so a caller cannot mutate a pending
        // reservation into a cookie-bearing record or different accounting value.
        const copy = row && typeof row === 'object' ? { ...row } : row;
        writes = writes.then(() => reserve(copy)); return writes;
      },
      async close() {
        if (closed) return; closed = true;
        try { await writes; await file.sync(); } catch { failed = true; }
        try { await file.close(); } catch { failed = true; }
        if (failed) throw new Error('LOAD_TARGET_JOURNAL_FAILED');
      },
    });
  } catch {
    await file?.close().catch(() => {});
    // Keep any exclusively reserved journal, including an incomplete one. Its
    // existence prevents an unknown outcome from receiving a fresh budget.
    throw new Error('LOAD_TARGET_JOURNAL_FAILED');
  }
}
