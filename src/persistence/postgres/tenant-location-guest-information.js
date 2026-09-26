import { normalizeTenantLocationsV2 } from '../../domain/tenant-locations.js';
import { publicSiteGuestInformation } from '../../domain/site-guest-information.js';

export async function loadSiteGuestInformationWithClient(client, tenantId) {
  const result = await client.query({
    name: 'tenant-locations-guest-information',
    text: 'SELECT id, guest_information FROM sites WHERE tenant_id = $1 ORDER BY id',
    values: [tenantId],
  });
  return Object.fromEntries(result.rows
    .filter((row) => row.guest_information !== null)
    .map((row) => [row.id, publicSiteGuestInformation(row.guest_information)]));
}

export function withSiteGuestInformation(configuration, guestInformation) {
  if (guestInformation !== null && (
    !guestInformation || typeof guestInformation !== 'object' || Array.isArray(guestInformation)
  )) throw new TypeError('TENANT_LOCATION_GUEST_SNAPSHOT_INVALID');
  const values = guestInformation ?? {};
  const siteIds = new Set(configuration.sites.map((site) => site.id));
  if (Object.keys(values).some((id) => !siteIds.has(id))) {
    throw new TypeError('TENANT_LOCATION_GUEST_SNAPSHOT_INVALID');
  }
  return normalizeTenantLocationsV2({
    sites: configuration.sites.map((site) => ({
      ...site,
      guestInformation: Object.hasOwn(values, site.id) ? values[site.id] : null,
    })),
    rooms: configuration.rooms,
  }, { stored: true });
}

export async function applySiteGuestInformationWithClient(client, tenantId, configuration) {
  for (const site of configuration.sites) {
    const value = publicSiteGuestInformation(site.guestInformation);
    const result = await client.query({
      name: 'tenant-locations-guest-information-update',
      text: 'UPDATE sites SET guest_information = $3::jsonb WHERE tenant_id = $1 AND id = $2',
      values: [tenantId, site.id, value === null ? null : JSON.stringify(value)],
    });
    if (result.rowCount !== 1) throw new TypeError('TENANT_LOCATION_GUEST_SITE_MISSING');
  }
}
