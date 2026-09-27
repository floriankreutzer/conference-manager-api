import { createHash, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const TENANT_QUOTA_BYTES = 100 * 1024 * 1024;
const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertIdentity(tenantId, roomId) {
  if (!isInternalUuid(tenantId) || typeof roomId !== 'string' || !ROOM_ID.test(roomId)) {
    throw new TypeError('TENANT_ROOM_MEDIA_ID_INVALID');
  }
}

export function createPostgresRoomMediaRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.connect !== 'function' || !auditRepository?.appendWithClient) {
    throw new TypeError('ROOM_MEDIA_REPOSITORY_DEPENDENCIES_REQUIRED');
  }

  return Object.freeze({
    async create({ tenantId, roomId, actorUserId, image, auditEvent }) {
      assertIdentity(tenantId, roomId);
      if (!isInternalUuid(actorUserId) || !Buffer.isBuffer(image?.bytes)
        || image.contentType !== 'image/webp') throw new TypeError('ROOM_MEDIA_INPUT_INVALID');
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
        const id = randomUUID();
        await client.query({
          name: 'room-media-insert',
          text: `INSERT INTO tenant_room_media_assets (
            tenant_id, id, room_id, bytes, byte_length, width, height,
            content_sha256, created_by_user_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          values: [tenantId, id, roomId, image.bytes, image.bytes.length, image.width, image.height,
            createHash('sha256').update(image.bytes).digest(), actorUserId],
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
        text: `SELECT asset.bytes, asset.content_type
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
      return row ? Object.freeze({ bytes: row.bytes, contentType: row.content_type }) : null;
    },
  });
}
