import { withPostgresTransaction } from './transaction.js';

function parseDetails(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function publicSite(row) {
  const details = parseDetails(row.details);
  return Object.freeze({
    id: row.id,
    name: row.name,
    active: row.active,
    timeZone: row.time_zone ?? null,
    address: details.address ?? null,
  });
}

function publicRoom(row) {
  const details = parseDetails(row.details);
  return Object.freeze({
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    capacity: Number(row.capacity),
    active: row.active,
    floor: details.floor ?? null,
    equipment: Object.freeze(Array.isArray(details.equipment) ? [...details.equipment] : []),
    accessibility: Object.freeze(Array.isArray(details.accessibility) ? [...details.accessibility] : []),
    serviceIds: Object.freeze(Array.isArray(details.serviceIds) ? [...details.serviceIds] : []),
    cateringPackageIds: Object.freeze(Array.isArray(details.cateringPackageIds) ? [...details.cateringPackageIds] : []),
    floorplanAssetId: details.floorplanAssetId ?? null,
    mediaAssetIds: Object.freeze(Array.isArray(details.mediaAssetIds) ? [...details.mediaAssetIds] : []),
  });
}

function providerContext(row) {
  return Object.freeze({
    roomId: row.room_id,
    provider: 'microsoft365',
    status: row.provider_status,
    displayName: row.provider_display_name,
    capacity: row.provider_capacity === null ? null : Number(row.provider_capacity),
    lastSeenAt: row.last_seen_at.toISOString(),
  });
}

async function loadConfiguration(client, tenantId) {
  const [sites, rooms] = await Promise.all([
    client.query({
      name: 'tenant-locations-sites-current',
      text: 'SELECT id, name, active, time_zone, details FROM sites WHERE tenant_id = $1 ORDER BY id',
      values: [tenantId],
    }),
    client.query({
      name: 'tenant-locations-rooms-current',
      text: 'SELECT id, site_id, name, capacity, active, details FROM rooms WHERE tenant_id = $1 ORDER BY id',
      values: [tenantId],
    }),
  ]);
  return Object.freeze({
    sites: Object.freeze(sites.rows.map(publicSite)),
    rooms: Object.freeze(rooms.rows.map(publicRoom)),
  });
}

async function loadProviderContext(client, tenantId) {
  const result = await client.query({
    name: 'tenant-locations-provider-context',
    text: `
      SELECT room_id, provider_status, provider_display_name, provider_capacity, last_seen_at
      FROM microsoft365_room_mappings
      WHERE tenant_id = $1
      ORDER BY room_id
    `,
    values: [tenantId],
  });
  return Object.freeze(result.rows.map(providerContext));
}

async function loadRevision(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock ? 'tenant-locations-revision-lock' : 'tenant-locations-revision',
    text: `SELECT locations_revision FROM tenants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    values: [tenantId],
  });
  if (!result.rows[0]) throw new Error('TENANT_NOT_FOUND');
  return Number(result.rows[0].locations_revision);
}

async function currentWithClient(client, tenantId) {
  const [revision, configuration, provider] = await Promise.all([
    loadRevision(client, tenantId),
    loadConfiguration(client, tenantId),
    loadProviderContext(client, tenantId),
  ]);
  return Object.freeze({ revision, configuration, providerContext: provider });
}

async function appendSnapshot(client, { tenantId, revision, configuration, changedAt, actorUserId }) {
  await client.query({
    name: 'tenant-locations-history-insert',
    text: `
      INSERT INTO tenant_location_revisions (
        tenant_id, revision, configuration, changed_at, actor_user_id
      )
      VALUES ($1, $2, $3::jsonb, $4, $5)
      ON CONFLICT (tenant_id, revision) DO NOTHING
    `,
    values: [tenantId, revision, JSON.stringify(configuration), changedAt, actorUserId],
  });
}

function siteDetails(site) {
  return JSON.stringify({ address: site.address });
}

function roomDetails(room) {
  return JSON.stringify({
    floor: room.floor,
    equipment: room.equipment,
    accessibility: room.accessibility,
    serviceIds: room.serviceIds,
    cateringPackageIds: room.cateringPackageIds,
    floorplanAssetId: room.floorplanAssetId,
    mediaAssetIds: room.mediaAssetIds,
  });
}

async function validateReferences(client, tenantId, current, proposed, changedAt) {
  const proposedRooms = new Map(proposed.rooms.map((room) => [room.id, room]));
  const proposedSites = new Map(proposed.sites.map((site) => [site.id, site]));
  const deactivatedRooms = current.rooms
    .filter((room) => room.active && proposedRooms.get(room.id)?.active === false)
    .map((room) => room.id);
  const deactivatedSites = current.sites
    .filter((site) => site.active && proposedSites.get(site.id)?.active === false)
    .map((site) => site.id);
  const affectedRoomIds = new Set(deactivatedRooms);
  current.rooms.filter((room) => deactivatedSites.includes(room.siteId)).forEach((room) => affectedRoomIds.add(room.id));
  if (affectedRoomIds.size > 0) {
    const ids = [...affectedRoomIds];
    const requestRefs = await client.query({
      name: 'tenant-locations-deactivation-request-reference',
      text: `
        SELECT 1
        FROM requests
        WHERE tenant_id = $1
          AND room_id = ANY($2::varchar[])
          AND status NOT IN ('Rejected', 'Cancelled')
          AND ends_at >= $3
        LIMIT 1
      `,
      values: [tenantId, ids, changedAt],
    });
    if (requestRefs.rowCount > 0) return 'TENANT_LOCATION_REFERENCED_REQUEST';
    const providerRefs = await client.query({
      name: 'tenant-locations-deactivation-provider-reference',
      text: `
        SELECT 1
        FROM booking_provider_references reference
        JOIN requests request
          ON request.tenant_id = reference.tenant_id
         AND request.id = reference.request_id
        WHERE reference.tenant_id = $1
          AND request.room_id = ANY($2::varchar[])
          AND reference.state <> 'cancelled'
        LIMIT 1
      `,
      values: [tenantId, ids],
    });
    if (providerRefs.rowCount > 0) return 'TENANT_LOCATION_REFERENCED_PROVIDER';
  }

  const serviceIds = [...new Set(proposed.rooms.flatMap((room) => room.serviceIds))];
  if (serviceIds.length > 0) {
    const services = await client.query({
      name: 'tenant-locations-service-references',
      text: 'SELECT id FROM services WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
      values: [tenantId, serviceIds],
    });
    const found = new Set(services.rows.map((row) => row.id));
    if (serviceIds.some((id) => !found.has(id))) return 'TENANT_LOCATION_SERVICE_REFERENCE_INVALID';
  }
  const packageIds = [...new Set(proposed.rooms.flatMap((room) => room.cateringPackageIds))];
  if (packageIds.length > 0) {
    const packages = await client.query({
      name: 'tenant-locations-catering-references',
      text: 'SELECT id FROM catering_packages WHERE tenant_id = $1 AND id = ANY($2::varchar[])',
      values: [tenantId, packageIds],
    });
    const found = new Set(packages.rows.map((row) => row.id));
    if (packageIds.some((id) => !found.has(id))) return 'TENANT_LOCATION_CATERING_REFERENCE_INVALID';
  }
  return null;
}

async function applyConfiguration(client, tenantId, configuration, changedAt) {
  for (const site of configuration.sites) {
    await client.query({
      name: 'tenant-locations-site-upsert',
      text: `
        INSERT INTO sites (tenant_id, id, name, active, time_zone, details, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
        ON CONFLICT (tenant_id, id)
        DO UPDATE SET
          name = EXCLUDED.name,
          active = EXCLUDED.active,
          time_zone = EXCLUDED.time_zone,
          details = EXCLUDED.details,
          updated_at = EXCLUDED.updated_at
      `,
      values: [tenantId, site.id, site.name, site.active, site.timeZone, siteDetails(site), changedAt],
    });
  }
  for (const room of configuration.rooms) {
    const result = await client.query({
      name: 'tenant-locations-room-update',
      text: `
        UPDATE rooms
        SET site_id = $3,
            name = $4,
            capacity = $5,
            active = $6,
            details = $7::jsonb,
            updated_at = $8
        WHERE tenant_id = $1 AND id = $2
      `,
      values: [tenantId, room.id, room.siteId, room.name, room.capacity, room.active, roomDetails(room), changedAt],
    });
    if (result.rowCount !== 1) throw new Error('TENANT_ROOM_PROVIDER_IMPORT_REQUIRED');
  }
}

export function createPostgresTenantLocationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function mutate({ tenantId, expectedRevision, nextRevision, configuration, changedAt, actorUserId, auditEvent }) {
    return withPostgresTransaction(pool, async (client) => {
      const currentRevision = await loadRevision(client, tenantId, { lock: true });
      if (currentRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision });
      const currentConfiguration = await loadConfiguration(client, tenantId);
      const referenceError = await validateReferences(client, tenantId, currentConfiguration, configuration, changedAt);
      if (referenceError) return Object.freeze({ status: 'invalid', code: referenceError });
      await appendSnapshot(client, {
        tenantId,
        revision: currentRevision,
        configuration: currentConfiguration,
        changedAt,
        actorUserId,
      });
      await applyConfiguration(client, tenantId, configuration, changedAt);
      const revisionResult = await client.query({
        name: 'tenant-locations-revision-advance',
        text: `
          UPDATE tenants
          SET locations_revision = $3, updated_at = $4
          WHERE id = $1 AND locations_revision = $2
          RETURNING locations_revision
        `,
        values: [tenantId, expectedRevision, nextRevision, changedAt],
      });
      if (revisionResult.rowCount !== 1) return Object.freeze({ status: 'conflict', currentRevision });
      await appendSnapshot(client, { tenantId, revision: nextRevision, configuration, changedAt, actorUserId });
      const audit = await auditRepository.appendWithClient(client, auditEvent);
      if (!audit) throw new Error('AUDIT_APPEND_FAILED');
      return currentWithClient(client, tenantId);
    });
  }

  return Object.freeze({
    async current(tenantId) {
      return currentWithClient(pool, tenantId);
    },
    async update(args) {
      const result = await mutate(args);
      if (result?.status === 'invalid') {
        const error = new Error(result.code);
        error.name = 'TenantLocationReferenceError';
        error.code = result.code;
        throw error;
      }
      return result;
    },
    async history(tenantId, limit) {
      const result = await pool.query({
        name: 'tenant-locations-history-list',
        text: `
          SELECT revision, changed_at, actor_user_id
          FROM tenant_location_revisions
          WHERE tenant_id = $1
          ORDER BY revision DESC
          LIMIT $2
        `,
        values: [tenantId, limit],
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        revision: Number(row.revision),
        changedAt: row.changed_at.toISOString(),
        actorUserId: row.actor_user_id,
      })));
    },
    async revision(tenantId, revision) {
      const result = await pool.query({
        name: 'tenant-locations-history-get',
        text: `
          SELECT revision, configuration, changed_at, actor_user_id
          FROM tenant_location_revisions
          WHERE tenant_id = $1 AND revision = $2
        `,
        values: [tenantId, revision],
      });
      const row = result.rows[0];
      return row ? Object.freeze({
        revision: Number(row.revision),
        configuration: row.configuration,
        changedAt: row.changed_at.toISOString(),
        actorUserId: row.actor_user_id,
      }) : null;
    },
    async rollback({ tenantId, expectedRevision, nextRevision, sourceRevision, changedAt, actorUserId, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const currentRevision = await loadRevision(client, tenantId, { lock: true });
        if (currentRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision });
        const sourceResult = await client.query({
          name: 'tenant-locations-history-source-lock',
          text: `
            SELECT configuration
            FROM tenant_location_revisions
            WHERE tenant_id = $1 AND revision = $2
            FOR SHARE
          `,
          values: [tenantId, sourceRevision],
        });
        if (!sourceResult.rows[0]) {
          const error = new Error('TENANT_LOCATION_REVISION_NOT_FOUND');
          error.code = 'TENANT_LOCATION_REVISION_NOT_FOUND';
          throw error;
        }
        const configuration = sourceResult.rows[0].configuration;
        const currentConfiguration = await loadConfiguration(client, tenantId);
        const referenceError = await validateReferences(client, tenantId, currentConfiguration, configuration, changedAt);
        if (referenceError) {
          const error = new Error(referenceError);
          error.code = referenceError;
          throw error;
        }
        await appendSnapshot(client, { tenantId, revision: currentRevision, configuration: currentConfiguration, changedAt, actorUserId });
        await applyConfiguration(client, tenantId, configuration, changedAt);
        await client.query({
          name: 'tenant-locations-rollback-revision-advance',
          text: `UPDATE tenants SET locations_revision = $3, updated_at = $4 WHERE id = $1 AND locations_revision = $2`,
          values: [tenantId, expectedRevision, nextRevision, changedAt],
        });
        await appendSnapshot(client, { tenantId, revision: nextRevision, configuration, changedAt, actorUserId });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return currentWithClient(client, tenantId);
      });
    },
  });
}
