import {
  TENANT_CONFIGURATION_DOMAIN,
  TenantConfigurationConflictError,
  TenantConfigurationInputError,
} from '../../domain/tenant-configuration/protocol.js';
import { createPostgresConfigurationDomainRepository } from './configuration-domain-repository.js';

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeStringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function safeAddress(value) {
  const address = safeObject(value);
  if (
    typeof address.line1 !== 'string'
    || typeof address.city !== 'string'
    || typeof address.postalCode !== 'string'
    || typeof address.countryCode !== 'string'
  ) {
    return null;
  }
  return {
    line1: address.line1,
    line2: typeof address.line2 === 'string' ? address.line2 : null,
    city: address.city,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

async function initializeLocations(client, tenantId) {
  const result = await client.query(
    `SELECT s.id AS site_id,s.name AS site_name,s.active AS site_active,
            s.time_zone,s.details AS site_details,
            r.id AS room_id,r.name AS room_name,r.capacity,r.active AS room_active,
            r.details AS room_details
       FROM sites s
       LEFT JOIN rooms r ON r.tenant_id = s.tenant_id AND r.site_id = s.id
      WHERE s.tenant_id = $1
      ORDER BY s.id,r.id`,
    [tenantId],
  );
  const sites = new Map();
  for (const row of result.rows) {
    if (!sites.has(row.site_id)) {
      const details = safeObject(row.site_details);
      sites.set(row.site_id, {
        id: row.site_id,
        name: row.site_name,
        active: row.site_active,
        timeZone: row.time_zone || 'UTC',
        address: safeAddress(details.address),
        rooms: [],
      });
    }
    if (row.room_id !== null) {
      const details = safeObject(row.room_details);
      sites.get(row.site_id).rooms.push({
        id: row.room_id,
        name: row.room_name,
        capacity: row.capacity,
        active: row.room_active,
        floor: typeof details.floor === 'string' ? details.floor : null,
        equipment: safeStringList(details.equipment),
        accessibility: safeStringList(details.accessibility),
      });
    }
  }
  return { sites: [...sites.values()] };
}

function assertExistingIdsRetained(existing, proposed, code) {
  const proposedIds = new Set(proposed);
  if (existing.some((id) => !proposedIds.has(id))) {
    throw new TenantConfigurationInputError(code);
  }
}

async function assertNoFutureReferences(client, tenantId, roomIds, changedAt) {
  if (roomIds.length === 0) return;
  const result = await client.query(
    `SELECT room_id
       FROM requests
      WHERE tenant_id = $1
        AND room_id = ANY($2::varchar[])
        AND ends_at > $3
        AND status NOT IN ('Rejected', 'Cancelled')
      LIMIT 1`,
    [tenantId, roomIds, changedAt],
  );
  if (result.rowCount > 0) {
    throw new TenantConfigurationConflictError(
      null,
      'TENANT_LOCATION_HAS_FUTURE_REQUESTS',
    );
  }
}

async function applyLocations(client, configuration, changedAt, tenantId) {
  const existingSites = await client.query(
    'SELECT id FROM sites WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
  const existingRooms = await client.query(
    'SELECT id,active FROM rooms WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
  const proposedRooms = configuration.sites.flatMap((site) => site.rooms);
  assertExistingIdsRetained(
    existingSites.rows.map((row) => row.id),
    configuration.sites.map((site) => site.id),
    'TENANT_SITE_ARCHIVE_REQUIRED',
  );
  assertExistingIdsRetained(
    existingRooms.rows.map((row) => row.id),
    proposedRooms.map((room) => room.id),
    'TENANT_ROOM_ARCHIVE_REQUIRED',
  );
  const proposedRoomById = new Map(proposedRooms.map((room) => [room.id, room]));
  const deactivatedRoomIds = existingRooms.rows
    .filter((row) => row.active && proposedRoomById.get(row.id)?.active === false)
    .map((row) => row.id);
  await assertNoFutureReferences(client, tenantId, deactivatedRoomIds, changedAt);

  for (const site of configuration.sites) {
    await client.query(
      `INSERT INTO sites (tenant_id,id,name,active,time_zone,details)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,id) DO UPDATE
         SET name = EXCLUDED.name,
             active = EXCLUDED.active,
             time_zone = EXCLUDED.time_zone,
             details = EXCLUDED.details`,
      [
        tenantId,
        site.id,
        site.name,
        site.active,
        site.timeZone,
        { address: site.address },
      ],
    );
    for (const room of site.rooms) {
      await client.query(
        `INSERT INTO rooms (tenant_id,id,site_id,name,capacity,active,details)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id,id) DO UPDATE
           SET site_id = EXCLUDED.site_id,
               name = EXCLUDED.name,
               capacity = EXCLUDED.capacity,
               active = EXCLUDED.active,
               details = EXCLUDED.details`,
        [
          tenantId,
          room.id,
          site.id,
          room.name,
          room.capacity,
          room.active,
          {
            floor: room.floor,
            equipment: room.equipment,
            accessibility: room.accessibility,
          },
        ],
      );
    }
  }
}

export function createPostgresLocationConfigurationRepository(store) {
  return createPostgresConfigurationDomainRepository({
    store,
    domain: TENANT_CONFIGURATION_DOMAIN.LOCATIONS,
    initialize: initializeLocations,
    applyProjection: applyLocations,
  });
}
