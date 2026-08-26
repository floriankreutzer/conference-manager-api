import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SITE_ID_PATTERN = ROOM_ID_PATTERN;
const EXTERNAL_ID_MAX = 512;
const ADDRESS_MAX = 320;
const PROVIDER_NAME_MAX = 512;
const PROVIDER_TENANT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function assertBoundedString(value, max, code) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(code);
  }
  return value;
}

function assertRoomId(value) {
  if (typeof value !== 'string' || !ROOM_ID_PATTERN.test(value)) throw new TypeError('ROOM_ID_INVALID');
}

function assertSiteId(value) {
  if (typeof value !== 'string' || !SITE_ID_PATTERN.test(value)) throw new TypeError('SITE_ID_INVALID');
}

function assertDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('ROOM_MAPPING_DATE_INVALID');
}

function assertCapacity(value, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new TypeError('ROOM_CAPACITY_INVALID');
  }
}

function assertProviderCapacity(value) {
  if (value === null) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new TypeError('MICROSOFT365_PROVIDER_CAPACITY_INVALID');
  }
}

function mapRoomMapping(row) {
  return Object.freeze({
    tenantId: row.tenant_id,
    roomId: row.room_id,
    integrationId: row.integration_id,
    externalRoomId: row.external_room_id,
    resourceAddress: row.resource_address,
    providerDisplayName: row.provider_display_name,
    providerCapacity: row.provider_capacity === null ? null : Number(row.provider_capacity),
    providerStatus: row.provider_status,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    localRoom: Object.freeze({
      id: row.room_id,
      siteId: row.site_id,
      name: row.name,
      capacity: Number(row.capacity),
      active: row.active,
    }),
  });
}

function mappingSelect(where) {
  return `
    SELECT
      mapping.tenant_id,
      mapping.room_id,
      mapping.integration_id,
      mapping.external_room_id,
      mapping.resource_address,
      mapping.provider_display_name,
      mapping.provider_capacity,
      mapping.provider_status,
      mapping.last_seen_at,
      room.site_id,
      room.name,
      room.capacity,
      room.active
    FROM microsoft365_room_mappings mapping
    JOIN rooms room
      ON room.tenant_id = mapping.tenant_id
      AND room.id = mapping.room_id
    ${where}
  `;
}

async function tenantLock(client, tenantId) {
  await client.query({
    name: 'microsoft365-room-mapping-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    values: [`microsoft365-room-mapping:${tenantId}`],
  });
  await client.query({
    name: 'microsoft365-room-mapping-tenant-row-lock',
    text: 'SELECT 1 FROM tenants WHERE id = $1 FOR SHARE',
    values: [tenantId],
  });
}

async function lockConnectionAuthority(
  client,
  { tenantId, integrationId, connectionVersion, providerTenantReference },
) {
  const result = await client.query({
    name: 'microsoft365-room-mapping-connection-authority',
    text: `
      SELECT 1
      FROM integrations
      WHERE tenant_id = $1
        AND id = $2
        AND provider = 'microsoft365'
        AND connection_version = $3
        AND provider_reference = $4
        AND status IN ('connected', 'degraded')
        AND places_permission_status = 'granted'
      FOR SHARE
    `,
    values: [tenantId, integrationId, connectionVersion, providerTenantReference],
  });
  return result.rowCount === 1;
}

function assertConnectionAuthority(connectionVersion, providerTenantReference) {
  if (!Number.isSafeInteger(connectionVersion) || connectionVersion < 1) {
    throw new TypeError('MICROSOFT365_CONNECTION_VERSION_INVALID');
  }
  if (typeof providerTenantReference !== 'string' || !PROVIDER_TENANT_PATTERN.test(providerTenantReference)) {
    throw new TypeError('MICROSOFT365_PROVIDER_TENANT_INVALID');
  }
}

async function appendAudit(client, auditRepository, event) {
  if (!event) return;
  const result = await auditRepository.appendWithClient(client, event);
  if (!result) throw new Error('AUDIT_APPEND_FAILED');
}

function validateProviderRoom(room) {
  assertBoundedString(room.externalRoomId, EXTERNAL_ID_MAX, 'MICROSOFT365_EXTERNAL_ROOM_ID_INVALID');
  assertBoundedString(room.resourceAddress, ADDRESS_MAX, 'MICROSOFT365_RESOURCE_ADDRESS_INVALID');
  assertBoundedString(room.providerDisplayName, PROVIDER_NAME_MAX, 'MICROSOFT365_PROVIDER_NAME_INVALID');
  assertProviderCapacity(room.providerCapacity);
}

function mappingChanged(existing, room) {
  return existing.resource_address !== room.resourceAddress
    || existing.provider_display_name !== room.providerDisplayName
    || (existing.provider_capacity === null ? null : Number(existing.provider_capacity)) !== room.providerCapacity
    || existing.provider_status !== 'active';
}

export function createPostgresMicrosoft365RoomMappingRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  async function listWithClient(client, tenantId, integrationId) {
    const result = await client.query({
      name: 'microsoft365-room-mapping-list-client',
      text: `${mappingSelect('WHERE mapping.tenant_id = $1 AND mapping.integration_id = $2')}
        ORDER BY mapping.external_room_id`,
      values: [tenantId, integrationId],
    });
    return result.rows.map(mapRoomMapping);
  }

  return Object.freeze({
    async listByTenantIdAndIntegrationId(tenantId, integrationId) {
      assertUuid(tenantId, 'TENANT_ID_INVALID');
      assertUuid(integrationId, 'INTEGRATION_ID_INVALID');
      const result = await pool.query({
        name: 'microsoft365-room-mapping-list',
        text: `${mappingSelect('WHERE mapping.tenant_id = $1 AND mapping.integration_id = $2')}
          ORDER BY mapping.external_room_id`,
        values: [tenantId, integrationId],
      });
      return result.rows.map(mapRoomMapping);
    },

    async existingSiteIds(tenantId, siteIds) {
      assertUuid(tenantId, 'TENANT_ID_INVALID');
      if (!Array.isArray(siteIds) || siteIds.length < 1 || siteIds.length > 100) {
        throw new TypeError('SITE_IDS_INVALID');
      }
      siteIds.forEach(assertSiteId);
      const result = await pool.query({
        name: 'microsoft365-room-mapping-sites',
        text: 'SELECT id FROM sites WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
        values: [tenantId, siteIds],
      });
      return new Set(result.rows.map((row) => row.id));
    },

    async importRooms({
      tenantId,
      integrationId,
      connectionVersion,
      providerTenantReference,
      rooms,
      changedAt,
      auditEventFor,
    }) {
      assertUuid(tenantId, 'TENANT_ID_INVALID');
      assertUuid(integrationId, 'INTEGRATION_ID_INVALID');
      assertConnectionAuthority(connectionVersion, providerTenantReference);
      assertDate(changedAt);
      if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 100) throw new TypeError('ROOM_IMPORT_INVALID');
      if (typeof auditEventFor !== 'function') throw new TypeError('AUDIT_EVENT_FACTORY_REQUIRED');
      for (const room of rooms) {
        assertRoomId(room.roomId);
        assertSiteId(room.siteId);
        assertBoundedString(room.localName, 160, 'ROOM_NAME_INVALID');
        assertCapacity(room.localCapacity);
        validateProviderRoom(room);
      }

      try {
        return await withPostgresTransaction(pool, async (client) => {
          await tenantLock(client, tenantId);
          if (!await lockConnectionAuthority(client, {
            tenantId,
            integrationId,
            connectionVersion,
            providerTenantReference,
          })) return Object.freeze({ status: 'stale' });
          const externalIds = rooms.map((room) => room.externalRoomId);
          const existingResult = await client.query({
            name: 'microsoft365-room-mapping-existing',
            text: `
              SELECT
                tenant_id, room_id, integration_id, external_room_id,
                resource_address, provider_display_name, provider_capacity,
                provider_status, last_seen_at
              FROM microsoft365_room_mappings
              WHERE tenant_id = $1
                AND integration_id = $2
                AND external_room_id = ANY($3::varchar[])
              FOR UPDATE
            `,
            values: [tenantId, integrationId, externalIds],
          });
          const existingByExternalId = new Map(
            existingResult.rows.map((row) => [row.external_room_id, row]),
          );

          for (const room of rooms) {
            const existing = existingByExternalId.get(room.externalRoomId);
            if (existing) {
              const changed = mappingChanged(existing, room);
              await client.query({
                name: 'microsoft365-room-mapping-refresh-import',
                text: `
                  UPDATE microsoft365_room_mappings
                  SET resource_address = $4,
                      provider_display_name = $5,
                      provider_capacity = $6,
                      provider_status = 'active',
                      last_seen_at = $7,
                      updated_at = $7
                  WHERE tenant_id = $1 AND integration_id = $2 AND external_room_id = $3
                `,
                values: [
                  tenantId,
                  integrationId,
                  room.externalRoomId,
                  room.resourceAddress,
                  room.providerDisplayName,
                  room.providerCapacity,
                  changedAt,
                ],
              });
              if (changed) {
                await appendAudit(client, auditRepository, auditEventFor({
                  roomId: existing.room_id,
                  operation: 'room_mapping_refreshed',
                  providerStatus: 'active',
                }));
              }
              continue;
            }

            await client.query({
              name: 'microsoft365-room-import-room',
              text: `
                INSERT INTO rooms (
                  tenant_id, id, site_id, name, capacity, active, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, true, $6, $6)
              `,
              values: [
                tenantId,
                room.roomId,
                room.siteId,
                room.localName,
                room.localCapacity,
                changedAt,
              ],
            });
            await client.query({
              name: 'microsoft365-room-mapping-insert',
              text: `
                INSERT INTO microsoft365_room_mappings (
                  tenant_id, room_id, integration_id, external_room_id,
                  resource_address, provider_display_name, provider_capacity,
                  provider_status, last_seen_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, $8)
              `,
              values: [
                tenantId,
                room.roomId,
                integrationId,
                room.externalRoomId,
                room.resourceAddress,
                room.providerDisplayName,
                room.providerCapacity,
                changedAt,
              ],
            });
            await appendAudit(client, auditRepository, auditEventFor({
              roomId: room.roomId,
              operation: 'room_imported',
              providerStatus: 'active',
            }));
          }

          return Object.freeze(await listWithClient(client, tenantId, integrationId));
        });
      } catch (error) {
        if (error?.code === '23505') return Object.freeze({ status: 'conflict' });
        throw error;
      }
    },

    async synchronize({
      tenantId,
      integrationId,
      connectionVersion,
      providerTenantReference,
      discoveredRooms,
      changedAt,
      auditEventFor,
    }) {
      assertUuid(tenantId, 'TENANT_ID_INVALID');
      assertUuid(integrationId, 'INTEGRATION_ID_INVALID');
      assertConnectionAuthority(connectionVersion, providerTenantReference);
      assertDate(changedAt);
      if (!Array.isArray(discoveredRooms) || discoveredRooms.length > 10_000) {
        throw new TypeError('ROOM_SYNC_INVALID');
      }
      if (typeof auditEventFor !== 'function') throw new TypeError('AUDIT_EVENT_FACTORY_REQUIRED');
      discoveredRooms.forEach(validateProviderRoom);
      const discoveredById = new Map(discoveredRooms.map((room) => [room.externalRoomId, room]));

      try {
        return await withPostgresTransaction(pool, async (client) => {
          await tenantLock(client, tenantId);
          if (!await lockConnectionAuthority(client, {
            tenantId,
            integrationId,
            connectionVersion,
            providerTenantReference,
          })) return Object.freeze({ status: 'stale' });
          const existingResult = await client.query({
            name: 'microsoft365-room-mapping-sync-existing',
            text: `
              SELECT
                tenant_id, room_id, integration_id, external_room_id,
                resource_address, provider_display_name, provider_capacity,
                provider_status, last_seen_at
              FROM microsoft365_room_mappings
              WHERE tenant_id = $1 AND integration_id = $2
              FOR UPDATE
            `,
            values: [tenantId, integrationId],
          });

          for (const existing of existingResult.rows) {
            const discovered = discoveredById.get(existing.external_room_id);
            if (!discovered) {
              if (existing.provider_status !== 'missing') {
                await client.query({
                  name: 'microsoft365-room-mapping-mark-missing',
                  text: `
                    UPDATE microsoft365_room_mappings
                    SET provider_status = 'missing', updated_at = $3
                    WHERE tenant_id = $1 AND room_id = $2
                  `,
                  values: [tenantId, existing.room_id, changedAt],
                });
                await appendAudit(client, auditRepository, auditEventFor({
                  roomId: existing.room_id,
                  operation: 'room_provider_missing',
                  providerStatus: 'missing',
                }));
              }
              continue;
            }

            const room = {
              ...discovered,
              providerDisplayName: discovered.providerDisplayName,
              providerCapacity: discovered.providerCapacity,
            };
            const changed = mappingChanged(existing, room);
            await client.query({
              name: 'microsoft365-room-mapping-sync-update',
              text: `
                UPDATE microsoft365_room_mappings
                SET resource_address = $4,
                    provider_display_name = $5,
                    provider_capacity = $6,
                    provider_status = 'active',
                    last_seen_at = $7,
                    updated_at = $7
                WHERE tenant_id = $1 AND integration_id = $2 AND external_room_id = $3
              `,
              values: [
                tenantId,
                integrationId,
                existing.external_room_id,
                discovered.resourceAddress,
                discovered.providerDisplayName,
                discovered.providerCapacity,
                changedAt,
              ],
            });
            if (changed) {
              await appendAudit(client, auditRepository, auditEventFor({
                roomId: existing.room_id,
                operation: 'room_provider_refreshed',
                providerStatus: 'active',
              }));
            }
          }

          return Object.freeze(await listWithClient(client, tenantId, integrationId));
        });
      } catch (error) {
        if (error?.code === '23505') return Object.freeze({ status: 'conflict' });
        throw error;
      }
    },
  });
}
