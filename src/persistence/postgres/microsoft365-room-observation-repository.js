import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const BOUNDED_TEXT = /^(?!.*[\u0000-\u001f\u007f]).+$/u;

function identifier(value, maximum, code) {
  if (typeof value !== 'string' || value.length > maximum || !BOUNDED_TEXT.test(value)) {
    throw new TypeError(code);
  }
  return value;
}

function room(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_INVALID');
  }
  if (
    value.capacity !== null
    && (!Number.isSafeInteger(value.capacity) || value.capacity < 0 || value.capacity > 1_000_000)
  ) throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_INVALID');
  return Object.freeze({
    externalRoomId: identifier(value.externalRoomId, 512, 'MICROSOFT365_ROOM_OBSERVATION_INVALID'),
    resourceAddress: identifier(value.resourceAddress, 320, 'MICROSOFT365_ROOM_OBSERVATION_INVALID'),
    providerDisplayName: identifier(value.displayName, 512, 'MICROSOFT365_ROOM_OBSERVATION_INVALID'),
    providerCapacity: value.capacity,
    providerStatus: value.providerStatus === 'inactive' ? 'inactive' : 'active',
  });
}

export function createPostgresMicrosoft365RoomObservationRepository(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  return Object.freeze({
    async recordDiscovery({ tenantId, integrationId, connectionVersion, rooms }) {
      if (!isInternalUuid(tenantId) || !isInternalUuid(integrationId)) {
        throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_SCOPE_INVALID');
      }
      if (!Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
        throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_VERSION_INVALID');
      }
      if (!Array.isArray(rooms) || rooms.length > 1_000) {
        throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_INVALID');
      }
      const normalized = rooms.map(room);
      if (new Set(normalized.map((entry) => entry.externalRoomId)).size !== normalized.length) {
        throw new TypeError('MICROSOFT365_ROOM_OBSERVATION_INVALID');
      }
      return withPostgresTransaction(pool, async (client) => {
        const authority = await client.query({
          name: 'microsoft365-room-observation-authority',
          text: `
            SELECT 1 FROM integrations
            WHERE tenant_id = $1 AND id = $2 AND provider = 'microsoft365'
              AND connection_version = $3 AND status IN ('connected', 'degraded')
            FOR SHARE
          `,
          values: [tenantId, integrationId, connectionVersion],
        });
        if (authority.rowCount !== 1) return false;
        for (const entry of normalized) {
          await client.query({
            name: 'microsoft365-room-observation-upsert',
            text: `
              INSERT INTO microsoft365_room_discovery_observations (
                tenant_id, integration_id, external_room_id, resource_address,
                provider_display_name, provider_capacity, provider_status,
                connection_version, observed_at, fresh_until, revision
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                clock_timestamp(), clock_timestamp() + INTERVAL '24 hours', 1)
              ON CONFLICT (tenant_id, integration_id, external_room_id) DO UPDATE SET
                resource_address = EXCLUDED.resource_address,
                provider_display_name = EXCLUDED.provider_display_name,
                provider_capacity = EXCLUDED.provider_capacity,
                provider_status = EXCLUDED.provider_status,
                connection_version = EXCLUDED.connection_version,
                observed_at = EXCLUDED.observed_at,
                fresh_until = EXCLUDED.fresh_until,
                revision = microsoft365_room_discovery_observations.revision + 1
            `,
            values: [
              tenantId, integrationId, entry.externalRoomId, entry.resourceAddress,
              entry.providerDisplayName, entry.providerCapacity, entry.providerStatus,
              connectionVersion,
            ],
          });
        }
        return true;
      });
    },
  });
}
