import { mediaObjectReference, verifyMediaObjectBytes, MediaObjectStorageError } from '../../media/object-storage-contract.js';
import { withPostgresTransaction } from './transaction.js';

const PHASES = new Set(['copy', 'rollback', 'purge']);
const TABLES = Object.freeze({ room: 'tenant_room_media_assets', catalogue: 'demo_catalogue_media_assets' });
const MAX_BATCH = 10;

function referenceFor(row, kind) {
  return mediaObjectReference({ tenantId: row.tenant_id, assetId: row.id, kind,
    contentType: row.content_type, byteLength: row.byte_length, sha256: row.content_sha256.toString('hex') });
}

function sameRevision(row, reference) {
  return row && row.tenant_id === reference.tenantId && row.id === reference.assetId
    && row.content_type === reference.contentType && row.byte_length === reference.byteLength
    && Buffer.isBuffer(row.content_sha256) && row.content_sha256.toString('hex') === reference.sha256;
}

// Operator-only port: never expose this factory through a browser route or runtime role.
// copy preserves PostgreSQL bytes. purge requires a separately retained restore-acceptance
// digest; rollback restores and verifies bytes before clearing the pointer. Neither operation
// deletes objects or immutable inventory custody.
export function createPostgresMediaBackfillRepository(pool, { mediaObjects, includeDemoCatalogue = false } = {}) {
  if (!pool?.query || !pool?.connect || !mediaObjects?.register || !mediaObjects?.putWithClient || !mediaObjects?.read
    || typeof includeDemoCatalogue !== 'boolean') throw new TypeError('MEDIA_BACKFILL_DEPENDENCIES_REQUIRED');
  return Object.freeze({
    async runBatch({ phase, kind, limit = MAX_BATCH, restoreEvidenceSha256 = null } = {}) {
      if (!PHASES.has(phase) || !Object.hasOwn(TABLES, kind) || (kind === 'catalogue' && !includeDemoCatalogue)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) throw new TypeError('MEDIA_BACKFILL_INPUT_INVALID');
      if (phase === 'purge' && (typeof restoreEvidenceSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(restoreEvidenceSha256))) throw new TypeError('MEDIA_BACKFILL_RESTORE_EVIDENCE_REQUIRED');
      const table = TABLES[kind];
      const predicate = phase === 'copy' ? 'object_key IS NULL AND bytes IS NOT NULL'
        : phase === 'purge' ? 'object_key IS NOT NULL AND bytes IS NOT NULL' : 'object_key IS NOT NULL';
      const deadline = Date.now() + 25000;
      const candidates = await pool.query({ name: `media-backfill-candidates-${phase}-${kind}`,
        text: `SELECT tenant_id,id,content_type,byte_length,content_sha256,object_key
          FROM ${table} WHERE ${predicate} ORDER BY tenant_id,id LIMIT $1`, values: [limit] });
      let inspected = 0;
      let changed = 0;
      let byteLength = 0;
      for (const candidate of candidates.rows) {
        if (Date.now() >= deadline) break;
        inspected += 1;
        const reference = referenceFor(candidate, kind);
        if (phase === 'copy') await mediaObjects.register(reference);
        const result = await withPostgresTransaction(pool, async (client) => {
          const locked = await client.query({ name: `media-backfill-lock-${phase}-${kind}`,
            text: `SELECT tenant_id,id,content_type,byte_length,content_sha256,object_key,bytes
              FROM ${table} WHERE tenant_id = $1 AND id = $2 AND ${predicate} FOR UPDATE SKIP LOCKED`,
            values: [reference.tenantId, reference.assetId] });
          const row = locked.rows[0];
          // A concurrent replacement/reset or another operator may have advanced this row.
          // Never publish old bytes or restore over a new revision.
          if (!sameRevision(row, reference)) return false;
          if (phase === 'copy') {
            verifyMediaObjectBytes(row.bytes, reference);
            const key = await mediaObjects.putWithClient(client, reference, row.bytes);
            await client.query({ name: `media-backfill-copy-${kind}`,
              text: `UPDATE ${table} SET object_key = $3 WHERE tenant_id = $1 AND id = $2`,
              values: [reference.tenantId, reference.assetId, key] });
          } else {
            if (row.object_key !== reference.key) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
            const restored = verifyMediaObjectBytes(await mediaObjects.read(reference, row.object_key), reference);
            if (phase === 'purge') {
              // Verify the retained database copy too. Evidence never substitutes for the
              // actual provider readback immediately before dropping authoritative bytes.
              verifyMediaObjectBytes(row.bytes, reference);
              await client.query({ name: `media-backfill-purge-${kind}`,
                text: `UPDATE ${table} SET bytes = NULL WHERE tenant_id = $1 AND id = $2`,
                values: [reference.tenantId, reference.assetId] });
            } else {
              await client.query({ name: `media-backfill-rollback-${kind}`,
                text: `UPDATE ${table} SET bytes = $3, object_key = NULL WHERE tenant_id = $1 AND id = $2`,
                values: [reference.tenantId, reference.assetId, restored] });
            }
          }
          return true;
        });
        if (result) { changed += 1; byteLength += reference.byteLength; }
      }
      return Object.freeze({ phase, kind, inspected, changed, byteLength,
        hasMore: inspected < candidates.rowCount || changed < inspected || candidates.rowCount === limit });
    },
  });
}
