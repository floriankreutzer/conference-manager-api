import { createHash } from 'node:crypto';
import { withPostgresTransaction } from './transaction.js';
import { isInternalUuid } from '../../domain/identifiers.js';

export function createPostgresDemoCatalogueMediaRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('DEMO_MEDIA_POOL_REQUIRED');
  }
  return Object.freeze({
    async replace({ tenantId, assetId, actorUserId, contentType, bytes, auditEvent }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(assetId)
        || !isInternalUuid(actorUserId) || !Buffer.isBuffer(bytes)
        || typeof auditEvent !== 'function') throw new TypeError('DEMO_MEDIA_INPUT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const digest = createHash('sha256').update(bytes).digest();
        const result = await client.query({
          name: 'demo-customer-media-replace',
          text: `UPDATE demo_catalogue_media_assets asset
            SET bytes = $3, content_type = $4, byte_length = $5, content_sha256 = $6
            WHERE tenant_id = $1 AND id = $2 AND (
              (owner_kind = 'room_plan' AND content_type = 'image/png'
                AND EXISTS (SELECT 1 FROM rooms room
                  WHERE room.tenant_id = asset.tenant_id AND room.id = asset.owner_id))
              OR (owner_kind = 'catering_package' AND content_type = 'image/webp'
                AND EXISTS (SELECT 1 FROM catering_packages pkg
                  WHERE pkg.tenant_id = asset.tenant_id AND pkg.id = asset.owner_id))
              OR (owner_kind = 'catering_item' AND content_type = 'image/webp'
                AND EXISTS (SELECT 1 FROM catering_items item
                  WHERE item.tenant_id = asset.tenant_id AND item.id = asset.owner_id))
            ) AND content_type = $4 RETURNING id`,
          values: [tenantId, assetId, bytes, contentType, bytes.length, digest],
        });
        if (result.rowCount !== 1) return null;
        if (!auditRepository?.appendWithClient) throw new TypeError('DEMO_MEDIA_AUDIT_REQUIRED');
        await auditRepository.appendWithClient(client, auditEvent({
          actorUserId, assetId, contentType, byteLength: bytes.length, sha256: digest.toString('hex'),
        }));
        return Object.freeze({ assetId, sha256: digest.toString('hex') });
      });
    },
    async find({ tenantId, assetId }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(assetId)) return null;
      const result = await pool.query({
        name: 'demo-customer-media-asset',
        text: `SELECT bytes, content_type, byte_length FROM demo_catalogue_media_assets
          WHERE tenant_id = $1 AND id = $2`,
        values: [tenantId, assetId],
      });
      if (result.rowCount !== 1) return null;
      return Object.freeze({
        bytes: result.rows[0].bytes,
        content_type: result.rows[0].content_type,
        byte_length: result.rows[0].byte_length,
      });
    },
    async list({ tenantId }) {
      if (!isInternalUuid(tenantId)) return [];
      const result = await pool.query({
        name: 'demo-customer-media-catalogue',
        text: `SELECT id, owner_kind, owner_id, content_type, alt_text
          FROM demo_catalogue_media_assets WHERE tenant_id = $1 ORDER BY id`,
        values: [tenantId],
      });
      return result.rows.map(({ id, owner_kind: ownerKind, owner_id: ownerId,
        content_type: contentType, alt_text: altText }) => Object.freeze({
        id, ownerKind, ownerId, contentType, altText,
      }));
    },
  });
}
