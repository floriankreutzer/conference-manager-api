import { isIanaTimeZone } from './site-time-zone.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class TenantLocationsInputError extends Error {
  constructor(code = 'TENANT_LOCATIONS_INVALID') {
    super(code);
    this.name = 'TenantLocationsInputError';
    this.code = code;
  }
}
function invalid(code) { throw new TenantLocationsInputError(code); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('TENANT_LOCATIONS_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid('TENANT_LOCATIONS_INVALID');
  return value;
}
function text(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') invalid('TENANT_LOCATIONS_INVALID');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || CONTROL_CHARACTER.test(normalized)) invalid('TENANT_LOCATIONS_INVALID');
  return normalized;
}
function id(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalid('TENANT_LOCATIONS_INVALID');
  return value;
}
function ids(value, maximum = 100) {
  if (!Array.isArray(value) || value.length > maximum) invalid('TENANT_LOCATIONS_INVALID');
  const normalized = value.map(id);
  if (new Set(normalized).size !== normalized.length) invalid('TENANT_LOCATIONS_INVALID');
  return Object.freeze(normalized);
}
function order(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) invalid('TENANT_LOCATIONS_INVALID');
  return value;
}

export function normalizeTenantLocations(value) {
  const input = exact(value, ['sites', 'rooms']);
  if (!Array.isArray(input.sites) || input.sites.length > 200 || !Array.isArray(input.rooms) || input.rooms.length > 1000) {
    invalid('TENANT_LOCATIONS_INVALID');
  }
  const siteIds = new Set();
  const sites = input.sites.map((entry) => {
    const site = exact(entry, ['id', 'name', 'active', 'timeZone', 'description', 'sortOrder']);
    const siteId = id(site.id);
    if (siteIds.has(siteId)) invalid('TENANT_LOCATIONS_INVALID');
    siteIds.add(siteId);
    if (typeof site.active !== 'boolean' || !isIanaTimeZone(site.timeZone)) invalid('TENANT_LOCATIONS_INVALID');
    return Object.freeze({
      id: siteId,
      name: text(site.name, 160),
      active: site.active,
      timeZone: site.timeZone,
      description: text(site.description, 1000, true),
      sortOrder: order(site.sortOrder),
    });
  });
  const roomIds = new Set();
  const rooms = input.rooms.map((entry) => {
    const room = exact(entry, [
      'id', 'siteId', 'name', 'capacity', 'active', 'description', 'floorLabel',
      'sortOrder', 'serviceIds', 'cateringPackageIds',
    ]);
    const roomId = id(room.id);
    if (roomIds.has(roomId)) invalid('TENANT_LOCATIONS_INVALID');
    roomIds.add(roomId);
    if (!siteIds.has(room.siteId) || typeof room.active !== 'boolean') invalid('TENANT_LOCATIONS_INVALID');
    if (!Number.isSafeInteger(room.capacity) || room.capacity < 1 || room.capacity > 100000) invalid('TENANT_LOCATIONS_INVALID');
    return Object.freeze({
      id: roomId,
      siteId: room.siteId,
      name: text(room.name, 160),
      capacity: room.capacity,
      active: room.active,
      description: text(room.description, 1000, true),
      floorLabel: text(room.floorLabel, 64, true),
      sortOrder: order(room.sortOrder),
      serviceIds: ids(room.serviceIds),
      cateringPackageIds: ids(room.cateringPackageIds),
    });
  });
  return Object.freeze({ sites: Object.freeze(sites), rooms: Object.freeze(rooms) });
}
