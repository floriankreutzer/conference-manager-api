import { isInternalUuid } from '../../domain/identifiers.js';

export function createPostgresDemoCatalogueMediaRepository(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('DEMO_MEDIA_POOL_REQUIRED');
  }
  return Object.freeze({
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
