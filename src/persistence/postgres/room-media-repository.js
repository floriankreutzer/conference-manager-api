import { createHash, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';
import { mediaObjectReference, MediaObjectStorageError } from '../../media/object-storage-contract.js';

const TENANT_QUOTA_BYTES = 100 * 1024 * 1024;
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentity(tenantId, roomId) {
  if (!isInternalUuid(tenantId) || typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
    throw new TypeError('TENANT_ROOM_MEDIA_ID_INVALID');
  }
}

export function createPostgresRoomMediaRepository(pool, { auditRepository, mediaObjects = null } = {}) {
  if (!pool || typeof pool.connect !== 'function' || !auditRepository?.appendWithClient) {
    throw new TypeError('ROOM_MEDIA_REPOSITORY_DEPENDENCIES_REQUIRED');
  }

  return Object.freeze({
    async create({ tenantId, roomId, actorUserId, image, auditEvent }) {
      assertIdentity(tenantId, roomId);
      if (!isInternalUuid(actorUserId) || !Buffer.isBuffer(image?.bytes)
        || image.contentType !== 'image/webp') throw new TypeError('ROOM_MEDIA_INPUT_INVALID');
      const id = randomUUID();
      const digest = createHash('sha256').update(image.bytes).digest();
      let reference;
      if (mediaObjects) {
        // Deny foreign/missing ownership before durable registration or provider I/O.
        // Recheck under the authoritative Tenant lock before publishing any bytes.
        const owner = await pool.query({ name: 'room-media-object-preflight-owner',
          text: `SELECT 1 FROM rooms room JOIN users actor ON actor.tenant_id = room.tenant_id
            WHERE room.tenant_id = $1 AND room.id = $2 AND actor.id = $3`,
          values: [tenantId, roomId, actorUserId] });
        if (owner.rowCount !== 1) return null;
        const quota = await pool.query({ name: 'room-media-object-preflight-quota',
          text: 'SELECT COALESCE(SUM(byte_length), 0)::bigint AS used FROM tenant_room_media_assets WHERE tenant_id = $1',
          values: [tenantId] });
        if (Number(quota.rows[0].used) + image.bytes.length > TENANT_QUOTA_BYTES) {
          return Object.freeze({ status: 'quota_exceeded' });
        }
        reference = mediaObjectReference({ tenantId, assetId: id, kind: 'room',
          contentType: image.contentType, byteLength: image.bytes.length, sha256: digest.toString('hex') });
        await mediaObjects.register(reference);
      }
      return withPostgresTransaction(pool, async (client) => {
        // The Tenant row serializes concurrent uploads, including uploads to different Rooms.
        const tenant = await client.query({
          name: 'room-media-lock-tenant',
          text: 'SELECT id FROM tenants WHERE id = $1 FOR UPDATE',
          values: [tenantId],
        });
        if (tenant.rowCount !== 1) return null;
        const room = await client.query({
          name: 'room-media-owner',
          text: 'SELECT 1 FROM rooms WHERE tenant_id = $1 AND id = $2',
          values: [tenantId, roomId],
        });
        if (room.rowCount !== 1) return null;
        const quota = await client.query({
          name: 'room-media-tenant-quota',
          text: 'SELECT COALESCE(SUM(byte_length), 0)::bigint AS used FROM tenant_room_media_assets WHERE tenant_id = $1',
          values: [tenantId],
        });
        if (Number(quota.rows[0].used) + image.bytes.length > TENANT_QUOTA_BYTES) {
          return Object.freeze({ status: 'quota_exceeded' });
        }
        const key = mediaObjects ? await mediaObjects.putWithClient(client, reference, image.bytes) : null;
        await client.query({
          name: 'room-media-insert',
          text: `INSERT INTO tenant_room_media_assets (
            tenant_id, id, room_id, bytes, byte_length, width, height,
            content_sha256, created_by_user_id, object_key
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          values: [tenantId, id, roomId, mediaObjects ? null : image.bytes, image.bytes.length, image.width, image.height,
            digest, actorUserId, key],
        });
        await auditRepository.appendWithClient(client, auditEvent(id));
        return Object.freeze({ status: 'created', assetId: id });
      });
    },

    async findAttached({ tenantId, roomId, assetId, includeInactive }) {
      assertIdentity(tenantId, roomId);
      if (!isInternalUuid(assetId) || typeof includeInactive !== 'boolean') return null;
      const result = await pool.query({
        name: 'room-media-attached-read',
        text: `SELECT CASE WHEN asset.object_key IS NULL THEN asset.bytes END AS bytes,
            asset.content_type, asset.object_key, asset.byte_length, asset.content_sha256
          FROM tenant_room_media_assets asset
          JOIN rooms room ON room.tenant_id = asset.tenant_id AND room.id = asset.room_id
          WHERE asset.tenant_id = $1 AND asset.room_id = $2 AND asset.id = $3
            AND ($4::boolean OR room.active)
            AND (room.details->>'floorplanAssetId' = asset.id::text
              OR (room.details->'mediaAssetIds') ? asset.id::text)
          LIMIT 1`,
        values: [tenantId, roomId, assetId, includeInactive],
      });
      const row = result.rows[0];
      if (!row) return null;
      if (row.object_key) {
        if (!mediaObjects) throw new MediaObjectStorageError();
        const bytes = await mediaObjects.read({ tenantId, assetId, kind: 'room',
          byteLength: row.byte_length, contentType: row.content_type,
          sha256: row.content_sha256.toString('hex') }, row.object_key);
        return Object.freeze({ bytes, contentType: row.content_type });
      }
      if (mediaObjects) throw new MediaObjectStorageError('MEDIA_STORAGE_BACKFILL_REQUIRED');
      return Object.freeze({ bytes: row.bytes, contentType: row.content_type });
    },

    pruneExpiredUnreferenced: (options) => pruneExpiredUnreferencedRoomMedia(pool, options),
  });
}

export async function pruneExpiredUnreferencedRoomMedia(pool, { tenantId, asOf, limit = 100 }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('ROOM_MEDIA_POOL_REQUIRED');
  if (!isInternalUuid(tenantId) || !(asOf instanceof Date)
    || Number.isNaN(asOf.getTime()) || !Number.isSafeInteger(limit)
    || limit < 1 || limit > 100) throw new TypeError('ROOM_MEDIA_RETENTION_INPUT_INVALID');
  const result = await pool.query({
    name: 'room-media-retention-bounded-procedure',
    text: 'SELECT deleted, bytes FROM public.prune_expired_unreferenced_room_media($1::uuid, $2::timestamptz, $3::integer)',
    values: [tenantId, asOf, limit],
  });
  return Object.freeze({
    deleted: result.rows[0].deleted,
    bytes: Number(result.rows[0].bytes),
  });
}
