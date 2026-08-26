import { isIanaTimeZone } from '../site-time-zone.js';
import {
  boundedInteger,
  boundedText,
  exactObject,
  nullableBoundedText,
  requireConfigurationSnapshot,
  safeIdentifier,
  TenantConfigurationInputError,
  uniqueStringList,
} from './protocol.js';

const SITE_LIMIT = 200;
const ROOM_LIMIT = 2_000;

function normalizeAddress(value) {
  if (value === null) return null;
  const address = exactObject(value, ['line1', 'postalCode', 'city', 'countryCode'], ['line2']);
  const countryCode = boundedText(address.countryCode, {
    minimum: 2,
    maximum: 2,
    code: 'TENANT_SITE_ADDRESS_INVALID',
  }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new TenantConfigurationInputError('TENANT_SITE_ADDRESS_INVALID');
  }
  return Object.freeze({
    line1: boundedText(address.line1, {
      minimum: 1,
      maximum: 160,
      code: 'TENANT_SITE_ADDRESS_INVALID',
    }),
    line2: nullableBoundedText(address.line2, {
      minimum: 1,
      maximum: 160,
      code: 'TENANT_SITE_ADDRESS_INVALID',
    }),
    postalCode: boundedText(address.postalCode, {
      minimum: 1,
      maximum: 32,
      code: 'TENANT_SITE_ADDRESS_INVALID',
    }),
    city: boundedText(address.city, {
      minimum: 1,
      maximum: 120,
      code: 'TENANT_SITE_ADDRESS_INVALID',
    }),
    countryCode,
  });
}

function normalizeRoom(value, roomIds) {
  const room = exactObject(
    value,
    ['id', 'name', 'capacity', 'active', 'floor', 'equipment', 'accessibility'],
  );
  const id = safeIdentifier(room.id, 'TENANT_ROOM_ID_INVALID');
  if (roomIds.has(id)) {
    throw new TenantConfigurationInputError('TENANT_ROOM_ID_DUPLICATE');
  }
  roomIds.add(id);
  if (typeof room.active !== 'boolean') {
    throw new TenantConfigurationInputError('TENANT_ROOM_ACTIVE_INVALID');
  }
  return Object.freeze({
    id,
    name: boundedText(room.name, {
      minimum: 1,
      maximum: 160,
      code: 'TENANT_ROOM_NAME_INVALID',
    }),
    capacity: boundedInteger(room.capacity, {
      minimum: 1,
      maximum: 100_000,
      code: 'TENANT_ROOM_CAPACITY_INVALID',
    }),
    active: room.active,
    floor: nullableBoundedText(room.floor, {
      minimum: 1,
      maximum: 80,
      code: 'TENANT_ROOM_FLOOR_INVALID',
    }),
    equipment: uniqueStringList(room.equipment, {
      limit: 50,
      itemMaximum: 80,
      code: 'TENANT_ROOM_EQUIPMENT_INVALID',
    }),
    accessibility: uniqueStringList(room.accessibility, {
      limit: 20,
      itemMaximum: 80,
      code: 'TENANT_ROOM_ACCESSIBILITY_INVALID',
    }),
  });
}

function retainedIds(current, proposed, code) {
  const proposedIds = new Set(proposed.map((entry) => entry.id));
  const missing = current.filter((entry) => !proposedIds.has(entry.id));
  if (missing.length > 0) {
    throw new TenantConfigurationInputError(code);
  }
}

export function normalizeLocationsConfiguration(value, currentSnapshot = null) {
  exactObject(value, ['sites']);
  if (!Array.isArray(value.sites) || value.sites.length > SITE_LIMIT) {
    throw new TenantConfigurationInputError('TENANT_SITES_INVALID');
  }
  const siteIds = new Set();
  const roomIds = new Set();
  const sites = value.sites.map((candidate) => {
    const site = exactObject(
      candidate,
      ['id', 'name', 'active', 'timeZone', 'address', 'rooms'],
    );
    const id = safeIdentifier(site.id, 'TENANT_SITE_ID_INVALID');
    if (siteIds.has(id)) {
      throw new TenantConfigurationInputError('TENANT_SITE_ID_DUPLICATE');
    }
    siteIds.add(id);
    if (typeof site.active !== 'boolean' || !isIanaTimeZone(site.timeZone)) {
      throw new TenantConfigurationInputError('TENANT_SITE_INVALID');
    }
    if (!Array.isArray(site.rooms) || roomIds.size + site.rooms.length > ROOM_LIMIT) {
      throw new TenantConfigurationInputError('TENANT_ROOMS_INVALID');
    }
    const rooms = site.rooms.map((room) => normalizeRoom(room, roomIds));
    if (!site.active && rooms.some((room) => room.active)) {
      throw new TenantConfigurationInputError('TENANT_INACTIVE_SITE_HAS_ACTIVE_ROOM');
    }
    return Object.freeze({
      id,
      name: boundedText(site.name, {
        minimum: 1,
        maximum: 160,
        code: 'TENANT_SITE_NAME_INVALID',
      }),
      active: site.active,
      timeZone: site.timeZone,
      address: normalizeAddress(site.address),
      rooms: Object.freeze(rooms),
    });
  });

  if (currentSnapshot?.sites) {
    retainedIds(currentSnapshot.sites, sites, 'TENANT_SITE_ARCHIVE_REQUIRED');
    const currentRooms = currentSnapshot.sites.flatMap((site) => site.rooms || []);
    const proposedRooms = sites.flatMap((site) => site.rooms);
    retainedIds(currentRooms, proposedRooms, 'TENANT_ROOM_ARCHIVE_REQUIRED');
  }
  return requireConfigurationSnapshot({ sites });
}
