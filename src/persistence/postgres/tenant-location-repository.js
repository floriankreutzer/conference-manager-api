import { isInternalUuid } from '../../domain/identifiers.js';
import {
  TenantLocationInputError,
  assertTenantLocationTransition,
  normalizeStoredTenantLocations,
  tenantLocationRollbackConfiguration,
} from '../../domain/tenant-locations.js';
import { withPostgresTransaction } from './transaction.js';

const SITE_DETAIL_KEYS = new Set(['address']);
const ROOM_DETAIL_KEYS = new Set([
  'floor',
  'equipment',
  'accessibility',
  'serviceIds',
  'cateringPackageIds',
  'floorplanAssetId',
  'mediaAssetIds',
]);
const PROVIDER_STATUSES = new Set(['active', 'missing']);

function persistedStateError() {
  const error = new Error('TENANT_LOCATION_PERSISTED_STATE_INVALID');
  error.code = 'TENANT_LOCATION_PERSISTED_STATE_INVALID';
  return error;
}

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
  return value;
}

function detailsObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw persistedStateError();
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw persistedStateError();
  return value;
}

function publicSite(row) {
  const details = detailsObject(row.details, SITE_DETAIL_KEYS);
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    timeZone: row.time_zone ?? null,
    address: details.address ?? null,
  };
}

function publicRoom(row) {
  const details = detailsObject(row.details, ROOM_DETAIL_KEYS);
  return {
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    capacity: Number(row.capacity),
    active: row.active,
    floor: details.floor ?? null,
    equipment: details.equipment ?? [],
    accessibility: details.accessibility ?? [],
    serviceIds: details.serviceIds ?? [],
    cateringPackageIds: details.cateringPackageIds ?? [],
    floorplanAssetId: details.floorplanAssetId ?? null,
    mediaAssetIds: details.mediaAssetIds ?? [],
  };
}

function publicProviderContext(row) {
  if (
    typeof row.room_id !== 'string'
    || !PROVIDER_STATUSES.has(row.provider_status)
    || typeof row.provider_display_name !== 'string'
    || !(row.last_seen_at instanceof Date)
    || Number.isNaN(row.last_seen_at.getTime())
  ) throw persistedStateError();
  const capacity = row.provider_capacity === null ? null : Number(row.provider_capacity);
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 1_000_000)) {
    throw persistedStateError();
  }
  return Object.freeze({
    roomId: row.room_id,
    provider: 'microsoft365',
    status: row.provider_status,
    displayName: row.provider_display_name,
    capacity,
    lastSeenAt: row.last_seen_at.toISOString(),
  });
}

function normalizePersistedConfiguration(value) {
  try {
    return normalizeStoredTenantLocations(value);
  } catch (error) {
    if (error instanceof TenantLocationInputError) throw persistedStateError();
    throw error;
  }
}

export async function loadTenantLocationConfigurationWithClient(client, tenantId) {
  const sites = await client.query({
    name: 'tenant-locations-sites-current',
    text: 'SELECT id, name, active, time_zone, details FROM sites WHERE tenant_id = $1 ORDER BY id',
    values: [tenantId],
  });
  const rooms = await client.query({
    name: 'tenant-locations-rooms-current',
    text: 'SELECT id, site_id, name, capacity, active, details FROM rooms WHERE tenant_id = $1 ORDER BY id',
    values: [tenantId],
  });
  return normalizePersistedConfiguration({
    sites: sites.rows.map(publicSite),
    rooms: rooms.rows.map(publicRoom),
  });
}

async function loadProviderContextWithClient(client, tenantId) {
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
  return Object.freeze(result.rows.map(publicProviderContext));
}

function requireRevision(value) {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw persistedStateError();
  }
  return revision;
}

async function loadTenantLocationRevisionWithClient(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock ? 'tenant-locations-revision-lock' : 'tenant-locations-revision',
    text: `SELECT locations_revision FROM tenants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    values: [tenantId],
  });
  if (!result.rows[0]) throw new Error('TENANT_NOT_FOUND');
  return requireRevision(result.rows[0].locations_revision);
}

export async function lockTenantLocationRevisionWithClient(client, tenantId) {
  return loadTenantLocationRevisionWithClient(client, tenantId, { lock: true });
}

async function currentWithClient(client, tenantId, knownRevision = null) {
  const revision = knownRevision ?? await loadTenantLocationRevisionWithClient(client, tenantId);
  const configuration = await loadTenantLocationConfigurationWithClient(client, tenantId);
  const providerContext = await loadProviderContextWithClient(client, tenantId);
  return Object.freeze({ revision, configuration, providerContext });
}

export async function ensureTenantLocationSnapshotWithClient(client, {
  tenantId,
  revision,
  configuration,
  changedAt,
  actorUserId,
}) {
  const safeRevision = requireRevision(revision);
  const normalized = normalizePersistedConfiguration(configuration);
  const existing = await client.query({
    name: 'tenant-locations-history-match',
    text: `
      SELECT configuration = $3::jsonb AS matches
      FROM tenant_location_revisions
      WHERE tenant_id = $1 AND revision = $2
    `,
    values: [tenantId, safeRevision, JSON.stringify(normalized)],
  });
  if (existing.rows[0]) {
    if (existing.rows[0].matches !== true) throw new Error('TENANT_LOCATION_SNAPSHOT_DIVERGED');
    return false;
  }
  await client.query({
    name: 'tenant-locations-history-insert',
    text: `
      INSERT INTO tenant_location_revisions (
        tenant_id, revision, configuration, changed_at, actor_user_id
      )
      VALUES ($1, $2, $3::jsonb, $4, $5)
    `,
    values: [tenantId, safeRevision, JSON.stringify(normalized), changedAt, actorUserId],
  });
  return true;
}

export async function advanceTenantLocationRevisionWithClient(client, {
  tenantId,
  currentRevision,
  nextRevision,
  changedAt,
}) {
  const safeCurrentRevision = requireRevision(currentRevision);
  const safeNextRevision = requireRevision(nextRevision);
  if (safeNextRevision !== safeCurrentRevision + 1) {
    throw new TypeError('TENANT_LOCATION_NEXT_REVISION_INVALID');
  }
  const result = await client.query({
    name: 'tenant-locations-revision-advance',
    text: `
      UPDATE tenants
      SET locations_revision = $3, updated_at = $4
      WHERE id = $1 AND locations_revision = $2
      RETURNING locations_revision
    `,
    values: [tenantId, safeCurrentRevision, safeNextRevision, changedAt],
  });
  if (result.rowCount !== 1) throw new Error('TENANT_LOCATION_REVISION_RACE');
  return requireRevision(result.rows[0].locations_revision);
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
    const bookingChangeRefs = await client.query({
      name: 'tenant-locations-deactivation-booking-change-reference',
      text: `
        SELECT 1
        FROM booking_change_requests
        WHERE tenant_id = $1
          AND room_id = ANY($2::varchar[])
          AND status = 'applying'
        LIMIT 1
      `,
      values: [tenantId, ids],
    });
    if (bookingChangeRefs.rowCount > 0) return 'TENANT_LOCATION_REFERENCED_BOOKING_CHANGE';
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

async function appendAudit(client, auditRepository, auditEvent) {
  const audit = await auditRepository.appendWithClient(client, auditEvent);
  if (!audit) throw new Error('AUDIT_APPEND_FAILED');
}

function repositoryInputError(code) {
  const error = new Error(code);
  error.name = 'TenantLocationReferenceError';
  error.code = code;
  return error;
}

function requireTransition(current, proposed) {
  try {
    return assertTenantLocationTransition(current, proposed);
  } catch (error) {
    if (error instanceof TenantLocationInputError) throw repositoryInputError(error.code);
    throw error;
  }
}

function requireRollbackConfiguration(current, source) {
  try {
    return tenantLocationRollbackConfiguration(current, source);
  } catch (error) {
    if (error instanceof TenantLocationInputError) throw repositoryInputError(error.code);
    throw error;
  }
}

export function createPostgresTenantLocationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  async function mutate({ tenantId, expectedRevision, nextRevision, configuration, changedAt, actorUserId, auditEvent }) {
    requireUuid(tenantId, 'TENANT_ID_INVALID');
    requireUuid(actorUserId, 'ACTOR_USER_ID_INVALID');
    return withPostgresTransaction(pool, async (client) => {
      const currentRevision = await lockTenantLocationRevisionWithClient(client, tenantId);
      if (currentRevision !== expectedRevision) return Object.freeze({ status: 'conflict', currentRevision });
      const currentConfiguration = await loadTenantLocationConfigurationWithClient(client, tenantId);
      const proposed = requireTransition(currentConfiguration, configuration);
      const referenceError = await validateReferences(client, tenantId, currentConfiguration, proposed, changedAt);
      if (referenceError) throw repositoryInputError(referenceError);
      await ensureTenantLocationSnapshotWithClient(client, {
        tenantId,
        revision: currentRevision,
        configuration: currentConfiguration,
        changedAt,
        actorUserId,
      });
      await applyConfiguration(client, tenantId, proposed, changedAt);
      await advanceTenantLocationRevisionWithClient(client, {
        tenantId,
        currentRevision,
        nextRevision,
        changedAt,
      });
      const applied = await loadTenantLocationConfigurationWithClient(client, tenantId);
      await ensureTenantLocationSnapshotWithClient(client, {
        tenantId,
        revision: nextRevision,
        configuration: applied,
        changedAt,
        actorUserId,
      });
      await appendAudit(client, auditRepository, auditEvent);
      return currentWithClient(client, tenantId, nextRevision);
    });
  }

  return Object.freeze({
    async current(tenantId) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        return currentWithClient(client, tenantId);
      }, { isolationLevel: 'REPEATABLE READ', readOnly: true });
    },
    async update(args) {
      return mutate(args);
    },
    async history(tenantId, limit) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
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
        revision: requireRevision(row.revision),
        changedAt: row.changed_at.toISOString(),
        actorUserId: requireUuid(row.actor_user_id, 'TENANT_LOCATION_HISTORY_ACTOR_INVALID'),
      })));
    },
    async revision(tenantId, revision) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      const requestedRevision = requireRevision(revision);
      const result = await pool.query({
        name: 'tenant-locations-history-get',
        text: `
          SELECT revision, configuration, changed_at, actor_user_id
          FROM tenant_location_revisions
          WHERE tenant_id = $1 AND revision = $2
        `,
        values: [tenantId, requestedRevision],
      });
      const row = result.rows[0];
      return row ? Object.freeze({
        revision: requireRevision(row.revision),
        configuration: normalizePersistedConfiguration(row.configuration),
        changedAt: row.changed_at.toISOString(),
        actorUserId: requireUuid(row.actor_user_id, 'TENANT_LOCATION_HISTORY_ACTOR_INVALID'),
      }) : null;
    },
    async rollback({ tenantId, expectedRevision, nextRevision, sourceRevision, changedAt, actorUserId, auditEvent }) {
      requireUuid(tenantId, 'TENANT_ID_INVALID');
      requireUuid(actorUserId, 'ACTOR_USER_ID_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const currentRevision = await lockTenantLocationRevisionWithClient(client, tenantId);
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
        if (!sourceResult.rows[0]) throw repositoryInputError('TENANT_LOCATION_REVISION_NOT_FOUND');
        const source = normalizePersistedConfiguration(sourceResult.rows[0].configuration);
        const current = await loadTenantLocationConfigurationWithClient(client, tenantId);
        const proposed = requireRollbackConfiguration(current, source);
        const referenceError = await validateReferences(client, tenantId, current, proposed, changedAt);
        if (referenceError) throw repositoryInputError(referenceError);
        await ensureTenantLocationSnapshotWithClient(client, {
          tenantId,
          revision: currentRevision,
          configuration: current,
          changedAt,
          actorUserId,
        });
        await applyConfiguration(client, tenantId, proposed, changedAt);
        await advanceTenantLocationRevisionWithClient(client, {
          tenantId,
          currentRevision,
          nextRevision,
          changedAt,
        });
        const applied = await loadTenantLocationConfigurationWithClient(client, tenantId);
        await ensureTenantLocationSnapshotWithClient(client, {
          tenantId,
          revision: nextRevision,
          configuration: applied,
          changedAt,
          actorUserId,
        });
        await appendAudit(client, auditRepository, auditEvent);
        return currentWithClient(client, tenantId, nextRevision);
      });
    },
  });
}
