import { normalizeTenantLocationsV3 } from '../../domain/tenant-locations.js';
import {
  normalizePublicRoomGuestValues,
  normalizePublicSiteGuestValues,
} from '../../domain/public-guest-values.js';

function requireMap(value, allowedIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((id) => !allowedIds.has(id))) {
    throw new TypeError('TENANT_LOCATION_PUBLIC_GUEST_SNAPSHOT_INVALID');
  }
  return value;
}

export async function loadPublicGuestValuesWithClient(client, tenantId) {
  const sites = await client.query({
      name: 'tenant-locations-public-guest-sites',
      text: 'SELECT id, guest_public_values FROM sites WHERE tenant_id = $1 ORDER BY id',
      values: [tenantId],
    });
  const rooms = await client.query({
      name: 'tenant-locations-public-guest-rooms',
      text: 'SELECT id, guest_public_values FROM rooms WHERE tenant_id = $1 ORDER BY id',
      values: [tenantId],
    });
  return Object.freeze({
    sites: Object.fromEntries(sites.rows.filter((row) => row.guest_public_values !== null)
      .map((row) => [row.id, normalizePublicSiteGuestValues(row.guest_public_values)])),
    rooms: Object.fromEntries(rooms.rows.filter((row) => row.guest_public_values !== null)
      .map((row) => [row.id, normalizePublicRoomGuestValues(row.guest_public_values)])),
  });
}

export function withPublicGuestValues(configuration, publicValues) {
  const root = publicValues ?? { sites: {}, rooms: {} };
  if (!root || typeof root !== 'object' || Array.isArray(root)
    || Object.keys(root).length !== 2 || !Object.hasOwn(root, 'sites')
    || !Object.hasOwn(root, 'rooms')) {
    throw new TypeError('TENANT_LOCATION_PUBLIC_GUEST_SNAPSHOT_INVALID');
  }
  const sites = requireMap(root.sites, new Set(configuration.sites.map((site) => site.id)));
  const rooms = requireMap(root.rooms, new Set(configuration.rooms.map((room) => room.id)));
  return normalizeTenantLocationsV3({
    sites: configuration.sites.map((site) => ({
      ...site, guestPublicValues: Object.hasOwn(sites, site.id) ? sites[site.id] : null,
    })),
    rooms: configuration.rooms.map((room) => ({
      ...room, guestPublicValues: Object.hasOwn(rooms, room.id) ? rooms[room.id] : null,
    })),
  }, { stored: true });
}

export async function applyPublicGuestValuesWithClient(client, tenantId, configuration) {
  for (const site of configuration.sites) {
    const values = normalizePublicSiteGuestValues(site.guestPublicValues);
    const result = await client.query({
      name: 'tenant-locations-public-guest-site-update',
      text: 'UPDATE sites SET guest_public_values = $3::jsonb WHERE tenant_id = $1 AND id = $2',
      values: [tenantId, site.id, values === null ? null : JSON.stringify(values)],
    });
    if (result.rowCount !== 1) throw new TypeError('TENANT_LOCATION_PUBLIC_GUEST_SITE_MISSING');
  }
  for (const room of configuration.rooms) {
    const values = normalizePublicRoomGuestValues(room.guestPublicValues);
    const result = await client.query({
      name: 'tenant-locations-public-guest-room-update',
      text: 'UPDATE rooms SET guest_public_values = $3::jsonb WHERE tenant_id = $1 AND id = $2',
      values: [tenantId, room.id, values === null ? null : JSON.stringify(values)],
    });
    if (result.rowCount !== 1) throw new TypeError('TENANT_LOCATION_PUBLIC_GUEST_ROOM_MISSING');
  }
}
