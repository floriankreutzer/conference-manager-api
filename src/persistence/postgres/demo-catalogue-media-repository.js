import { createHash, randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './transaction.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { mediaObjectReference, MediaObjectStorageError } from '../../media/object-storage-contract.js';

const LIVE_OWNER = `(
  (owner_kind = 'room_plan' AND EXISTS (SELECT 1 FROM rooms room
    WHERE room.tenant_id = asset.tenant_id AND room.id = asset.owner_id))
  OR (owner_kind = 'catering_package' AND EXISTS (SELECT 1 FROM catering_packages pkg
    WHERE pkg.tenant_id = asset.tenant_id AND pkg.id = asset.owner_id))
  OR (owner_kind = 'catering_item' AND EXISTS (SELECT 1 FROM catering_items item
    WHERE item.tenant_id = asset.tenant_id AND item.id = asset.owner_id))
)`;

export function createPostgresDemoCatalogueMediaRepository(pool, { auditRepository, mediaObjects = null } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('DEMO_MEDIA_POOL_REQUIRED');
  }
  return Object.freeze({
    async create({ tenantId, ownerKind, ownerId, actorUserId, contentType, bytes, altText, auditEvent }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(actorUserId)
        || !['catering_item', 'catering_package'].includes(ownerKind)
        || typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)
        || contentType !== 'image/webp' || !Buffer.isBuffer(bytes)
        || typeof altText !== 'string' || altText.length < 1 || altText.length > 160
        || typeof auditEvent !== 'function') throw new TypeError('DEMO_MEDIA_INPUT_INVALID');
      const assetId = randomUUID();
      const digest = createHash('sha256').update(bytes).digest();
      let reference;
      if (mediaObjects) {
        const ownerTable = ownerKind === 'catering_item' ? 'catering_items' : 'catering_packages';
        const owner = await pool.query({ name: `demo-media-object-preflight-create-${ownerKind}`,
          text: `SELECT 1 FROM ${ownerTable} owner JOIN users actor ON actor.tenant_id = owner.tenant_id
            WHERE owner.tenant_id = $1 AND owner.id = $2 AND actor.id = $3`,
          values: [tenantId, ownerId, actorUserId] });
        if (owner.rowCount !== 1) return null;
        const existing = await pool.query({ name: 'demo-media-object-preflight-existing',
          text: 'SELECT 1 FROM demo_catalogue_media_assets WHERE tenant_id = $1 AND owner_kind = $2 AND owner_id = $3',
          values: [tenantId, ownerKind, ownerId] });
        if (existing.rowCount) return Object.freeze({ conflict: true });
        reference = mediaObjectReference({ tenantId, assetId, kind: 'catalogue',
          contentType, byteLength: bytes.length, sha256: digest.toString('hex') });
        await mediaObjects.register(reference);
      }
      return withPostgresTransaction(pool, async (client) => {
        const ownerTable = ownerKind === 'catering_item' ? 'catering_items' : 'catering_packages';
        const owner = await client.query({
          name: `demo-customer-media-create-owner-${ownerKind}`,
          text: `SELECT id FROM ${ownerTable} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          values: [tenantId, ownerId],
        });
        if (owner.rowCount !== 1) return null;
        const existing = await client.query({
          name: 'demo-customer-media-create-existing',
          text: `SELECT id FROM demo_catalogue_media_assets
            WHERE tenant_id = $1 AND owner_kind = $2 AND owner_id = $3`,
          values: [tenantId, ownerKind, ownerId],
        });
        if (existing.rowCount) return Object.freeze({ conflict: true });
        const key = mediaObjects ? await mediaObjects.putWithClient(client, reference, bytes) : null;
        await client.query({
          name: 'demo-customer-media-create',
          text: `INSERT INTO demo_catalogue_media_assets (
              tenant_id, id, owner_kind, owner_id, bytes, content_type, byte_length,
              content_sha256, alt_text, created_at, created_by_user_id, object_key
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),$10,$11)`,
          values: [tenantId, assetId, ownerKind, ownerId, mediaObjects ? null : bytes, contentType, bytes.length,
            digest, altText, actorUserId, key],
        });
        if (!auditRepository?.appendWithClient) throw new TypeError('DEMO_MEDIA_AUDIT_REQUIRED');
        await auditRepository.appendWithClient(client, auditEvent({
          actorUserId, assetId, ownerKind, ownerId, contentType,
          byteLength: bytes.length, sha256: digest.toString('hex'),
        }));
        return Object.freeze({ assetId, sha256: digest.toString('hex') });
      });
    },
    async remove({ tenantId, assetId, actorUserId, auditEvent }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(assetId) || !isInternalUuid(actorUserId)
        || typeof auditEvent !== 'function') throw new TypeError('DEMO_MEDIA_INPUT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const deleted = await client.query({
          name: 'demo-customer-media-delete',
          text: `DELETE FROM demo_catalogue_media_assets asset
            WHERE tenant_id = $1 AND id = $2 AND owner_kind IN ('catering_item','catering_package')
              AND (
                (owner_kind = 'catering_package' AND EXISTS (SELECT 1 FROM catering_packages pkg
                  WHERE pkg.tenant_id = asset.tenant_id AND pkg.id = asset.owner_id))
                OR (owner_kind = 'catering_item' AND EXISTS (SELECT 1 FROM catering_items item
                  WHERE item.tenant_id = asset.tenant_id AND item.id = asset.owner_id))
              )
            RETURNING owner_kind, owner_id`,
          values: [tenantId, assetId],
        });
        if (deleted.rowCount !== 1) return false;
        if (!auditRepository?.appendWithClient) throw new TypeError('DEMO_MEDIA_AUDIT_REQUIRED');
        await auditRepository.appendWithClient(client, auditEvent({
          actorUserId, assetId, ownerKind: deleted.rows[0].owner_kind, ownerId: deleted.rows[0].owner_id,
        }));
        return true;
      });
    },
    async replace({ tenantId, assetId, actorUserId, contentType, bytes, auditEvent }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(assetId)
        || !isInternalUuid(actorUserId) || !Buffer.isBuffer(bytes)
        || !['image/png', 'image/webp'].includes(contentType)
        || typeof auditEvent !== 'function') throw new TypeError('DEMO_MEDIA_INPUT_INVALID');
      const digest = createHash('sha256').update(bytes).digest();
      let reference;
      if (mediaObjects) {
        const owned = await pool.query({ name: 'demo-media-object-preflight-replace',
          text: `SELECT 1 FROM demo_catalogue_media_assets asset
            WHERE tenant_id = $1 AND id = $2 AND content_type = $3 AND ${LIVE_OWNER}
              AND ((owner_kind = 'room_plan' AND content_type = 'image/png')
                OR (owner_kind IN ('catering_item','catering_package') AND content_type = 'image/webp'))
              AND EXISTS (SELECT 1 FROM users actor WHERE actor.tenant_id = $1 AND actor.id = $4)`,
          values: [tenantId, assetId, contentType, actorUserId] });
        if (owned.rowCount !== 1) return null;
        reference = mediaObjectReference({ tenantId, assetId, kind: 'catalogue',
          contentType, byteLength: bytes.length, sha256: digest.toString('hex') });
        await mediaObjects.register(reference);
      }
      return withPostgresTransaction(pool, async (client) => {
        if (mediaObjects) {
          const owned = await client.query({ name: 'demo-media-object-replace-owner-lock',
            text: `SELECT id FROM demo_catalogue_media_assets asset
              WHERE tenant_id = $1 AND id = $2 AND content_type = $3 AND ${LIVE_OWNER}
                AND ((owner_kind = 'room_plan' AND content_type = 'image/png')
                  OR (owner_kind IN ('catering_item','catering_package') AND content_type = 'image/webp')) FOR UPDATE`,
            values: [tenantId, assetId, contentType] });
          if (owned.rowCount !== 1) return null;
        }
        const key = mediaObjects ? await mediaObjects.putWithClient(client, reference, bytes) : null;
        const result = await client.query({
          name: 'demo-customer-media-replace',
          text: `UPDATE demo_catalogue_media_assets asset
            SET bytes = $3, content_type = $4, byte_length = $5, content_sha256 = $6, object_key = $7
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
          values: [tenantId, assetId, mediaObjects ? null : bytes, contentType, bytes.length, digest, key],
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
        text: `SELECT CASE WHEN object_key IS NULL THEN bytes END AS bytes,
            content_type, byte_length, content_sha256, object_key FROM demo_catalogue_media_assets asset
          WHERE asset.tenant_id = $1 AND asset.id = $2 AND (
            (owner_kind = 'room_plan' AND EXISTS (SELECT 1 FROM rooms room
              WHERE room.tenant_id = asset.tenant_id AND room.id = asset.owner_id))
            OR (owner_kind = 'catering_package' AND EXISTS (SELECT 1 FROM catering_packages pkg
              WHERE pkg.tenant_id = asset.tenant_id AND pkg.id = asset.owner_id))
            OR (owner_kind = 'catering_item' AND EXISTS (SELECT 1 FROM catering_items item
              WHERE item.tenant_id = asset.tenant_id AND item.id = asset.owner_id))
          )`,
        values: [tenantId, assetId],
      });
      if (result.rowCount !== 1) return null;
      const row = result.rows[0];
      let bytes = row.bytes;
      if (row.object_key) {
        if (!mediaObjects) throw new MediaObjectStorageError();
        bytes = await mediaObjects.read({ tenantId, assetId, kind: 'catalogue',
          contentType: row.content_type, byteLength: row.byte_length,
          sha256: row.content_sha256.toString('hex') }, row.object_key);
      } else if (mediaObjects) throw new MediaObjectStorageError('MEDIA_STORAGE_BACKFILL_REQUIRED');
      return Object.freeze({
        bytes,
        content_type: row.content_type,
        byte_length: row.byte_length,
      });
    },
    async list({ tenantId }) {
      if (!isInternalUuid(tenantId)) return [];
      const result = await pool.query({
        name: 'demo-customer-media-catalogue',
        text: `SELECT id, owner_kind, owner_id, content_type, alt_text
          FROM demo_catalogue_media_assets asset WHERE asset.tenant_id = $1 AND (
            (owner_kind = 'room_plan' AND EXISTS (SELECT 1 FROM rooms room
              WHERE room.tenant_id = asset.tenant_id AND room.id = asset.owner_id))
            OR (owner_kind = 'catering_package' AND EXISTS (SELECT 1 FROM catering_packages pkg
              WHERE pkg.tenant_id = asset.tenant_id AND pkg.id = asset.owner_id))
            OR (owner_kind = 'catering_item' AND EXISTS (SELECT 1 FROM catering_items item
              WHERE item.tenant_id = asset.tenant_id AND item.id = asset.owner_id))
          ) ORDER BY asset.id`,
        values: [tenantId],
      });
      return result.rows.map(({ id, owner_kind: ownerKind, owner_id: ownerId,
        content_type: contentType, alt_text: altText }) => Object.freeze({
        id, ownerKind, ownerId, contentType, altText,
      }));
    },
  });
}
