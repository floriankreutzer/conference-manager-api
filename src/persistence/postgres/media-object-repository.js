import { mediaObjectReference, verifyMediaObjectBytes, MediaObjectStorageError } from '../../media/object-storage-contract.js';
import { isPostgresTransactionActive, withPostgresTransaction } from './transaction.js';

const MAX_REGISTERED_PER_TENANT = 10000;

function rowMatches(row, reference) {
  return row?.object_key === reference.key && row.tenant_id === reference.tenantId
    && row.asset_id === reference.assetId && row.kind === reference.kind
    && row.content_type === reference.contentType && row.byte_length === reference.byteLength
    && Buffer.isBuffer(row.content_sha256) && row.content_sha256.toString('hex') === reference.sha256;
}

export function createPostgresMediaObjectRepository(pool, { storage, includeDemoCatalogue = false } = {}) {
  if (!pool?.connect || !storage?.put || !storage?.get || !storage?.remove
    || typeof includeDemoCatalogue !== 'boolean') throw new TypeError('MEDIA_OBJECT_REPOSITORY_DEPENDENCIES_REQUIRED');

  return Object.freeze({
    // Register BEFORE entering the authoritative metadata transaction. This committed
    // intent survives process death, an upload failure, audit failure or reset rollback.
    async register(input) {
      if (isPostgresTransactionActive(pool)) throw new TypeError('MEDIA_OBJECT_REGISTRATION_REQUIRES_INDEPENDENT_COMMIT');
      const reference = mediaObjectReference(input);
      return withPostgresTransaction(pool, async (client) => {
        await client.query({ name: 'media-object-registration-tenant-lock',
          text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 384301))', values: [reference.tenantId] });
        const existing = await client.query({ name: 'media-object-registration-existing',
          text: 'SELECT * FROM media_object_inventory WHERE tenant_id = $1 AND object_key = $2',
          values: [reference.tenantId, reference.key] });
        if (existing.rowCount) {
          if (!rowMatches(existing.rows[0], reference)) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
          return reference;
        }
        const quota = await client.query({ name: 'media-object-registration-quota',
          text: 'SELECT count(*)::integer AS count FROM media_object_inventory WHERE tenant_id = $1',
          values: [reference.tenantId] });
        if (quota.rows[0].count >= MAX_REGISTERED_PER_TENANT) throw new MediaObjectStorageError('MEDIA_STORAGE_INVENTORY_LIMIT');
        await client.query({ name: 'media-object-register',
          text: `INSERT INTO media_object_inventory
            (object_key, tenant_id, asset_id, kind, content_type, byte_length, content_sha256)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          values: [reference.key, reference.tenantId, reference.assetId, reference.kind,
            reference.contentType, reference.byteLength, Buffer.from(reference.sha256, 'hex')] });
        return reference;
      });
    },

    // The same row lock is held by cleanup. Writers never publish a key whose
    // inventory vanished between registration and acquiring this transaction lock.
    async putWithClient(client, input, bytes) {
      if (!client || !isPostgresTransactionActive(pool, client)) throw new TypeError('MEDIA_OBJECT_UPLOAD_TRANSACTION_REQUIRED');
      const reference = mediaObjectReference(input);
      verifyMediaObjectBytes(bytes, reference);
      const intent = await client.query({ name: 'media-object-upload-lock',
        text: 'SELECT * FROM media_object_inventory WHERE tenant_id = $1 AND object_key = $2 FOR UPDATE',
        values: [reference.tenantId, reference.key] });
      if (intent.rowCount !== 1 || !rowMatches(intent.rows[0], reference)) {
        throw new MediaObjectStorageError('MEDIA_STORAGE_INTENT_MISSING');
      }
      if (await storage.put(reference, bytes) !== reference.key) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
      verifyMediaObjectBytes(await storage.get(reference), reference);
      return reference.key;
    },

    async read(input, persistedKey) {
      const reference = mediaObjectReference(input);
      if (persistedKey !== reference.key) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
      return verifyMediaObjectBytes(await storage.get(reference), reference);
    },

    // Run only with a separate maintenance identity. No browser-controlled cutoff,
    // key or Tenant is accepted. Live metadata protects historical Room references,
    // because the existing retention procedure retains those asset rows.
    async pruneOrphans({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('MEDIA_OBJECT_RETENTION_LIMIT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const deadline = Date.now() + 25000;
        const rows = await client.query({ name: 'media-object-retention-batch',
          text: `SELECT inventory.* FROM media_object_inventory inventory
            WHERE registered_at < clock_timestamp() - INTERVAL '30 days'
              AND NOT EXISTS (SELECT 1 FROM tenant_room_media_assets asset
                WHERE asset.tenant_id = inventory.tenant_id AND asset.object_key = inventory.object_key)
              ${includeDemoCatalogue ? `AND NOT EXISTS (SELECT 1 FROM demo_catalogue_media_assets asset
                WHERE asset.tenant_id = inventory.tenant_id AND asset.object_key = inventory.object_key)` : ''}
              ${includeDemoCatalogue ? '' : "AND kind = 'room'"}
            ORDER BY registered_at, object_key LIMIT $1 FOR UPDATE SKIP LOCKED`, values: [limit] });
        let deleted = 0;
        let bytes = 0;
        let inspected = 0;
        for (const row of rows.rows) {
          if (Date.now() >= deadline) break;
          inspected += 1;
          const room = await client.query({ name: 'media-object-live-room-reference',
            text: 'SELECT 1 FROM tenant_room_media_assets WHERE tenant_id = $1 AND object_key = $2 LIMIT 1',
            values: [row.tenant_id, row.object_key] });
          if (room.rowCount) continue;
          if (includeDemoCatalogue) {
            const catalogue = await client.query({ name: 'media-object-live-catalogue-reference',
              text: 'SELECT 1 FROM demo_catalogue_media_assets WHERE tenant_id = $1 AND object_key = $2 LIMIT 1',
              values: [row.tenant_id, row.object_key] });
            if (catalogue.rowCount) continue;
          }
          const reference = mediaObjectReference({ tenantId: row.tenant_id, assetId: row.asset_id,
            kind: row.kind, contentType: row.content_type, byteLength: row.byte_length,
            sha256: row.content_sha256.toString('hex') });
          if (!rowMatches(row, reference)) throw new MediaObjectStorageError('MEDIA_STORAGE_INTEGRITY_FAILED');
          if (row.kind === 'catalogue' && !includeDemoCatalogue) continue;
          await storage.remove(reference);
          await client.query({ name: 'media-object-retention-delete-intent',
            text: 'DELETE FROM media_object_inventory WHERE tenant_id = $1 AND object_key = $2',
            values: [row.tenant_id, row.object_key] });
          deleted += 1;
          bytes += row.byte_length;
        }
        return Object.freeze({ inspected, deleted, bytes,
          hasMore: inspected < rows.rowCount || rows.rowCount === limit });
      });
    },
  });
}
