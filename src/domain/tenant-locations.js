import {
  hasUnsafeGuestRoomText,
  normalizeSiteGuestInformation,
} from './site-guest-information.js';
import { isIanaTimeZone } from './site-time-zone.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SITE_LIMIT = 200;
const ROOM_LIMIT = 2_000;
const TEXT_MAX = 160;

export class TenantLocationInputError extends Error {
  constructor(code = 'TENANT_LOCATIONS_INVALID') {
    super(code);
    this.name = 'TenantLocationInputError';
    this.code = code;
  }
}

function inputError(code) {
  throw new TenantLocationInputError(code);
}

function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError('TENANT_LOCATIONS_INVALID');
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    inputError('TENANT_LOCATIONS_INVALID');
  }
  return value;
}

function boundedText(value, code, maximum = TEXT_MAX) {
  if (typeof value !== 'string') inputError(code);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    inputError(code);
  }
  return normalized;
}

function nullableText(value, code, maximum = TEXT_MAX) {
  if (value === null) return null;
  return boundedText(value, code, maximum);
}

function publicPresentationText(value, code, maximum = TEXT_MAX) {
  if (typeof value !== 'string' || hasUnsafeGuestRoomText(value)) inputError(code);
  const normalized = boundedText(value, code, maximum);
  return normalized;
}

function safeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) inputError(code);
  return value;
}

function stringList(value, {
  code, limit = 50, maximum = 80, normalize = boundedText,
} = {}) {
  if (!Array.isArray(value) || value.length > limit) inputError(code);
  const result = value.map((entry) => normalize(entry, code, maximum));
  if (new Set(result).size !== result.length) inputError(code);
  return Object.freeze(result);
}

function idList(value, code, limit = 200) {
  if (!Array.isArray(value) || value.length > limit) inputError(code);
  const result = value.map((entry) => safeId(entry, code));
  if (new Set(result).size !== result.length) inputError(code);
  return Object.freeze(result);
}

function assetId(value, code) {
  if (typeof value !== 'string' || !ASSET_ID.test(value)) inputError(code);
  return value;
}

function assetList(value) {
  if (!Array.isArray(value) || value.length > 20) inputError('TENANT_ROOM_MEDIA_INVALID');
  const result = value.map((entry) => assetId(entry, 'TENANT_ROOM_MEDIA_INVALID'));
  if (new Set(result).size !== result.length) inputError('TENANT_ROOM_MEDIA_INVALID');
  return Object.freeze(result);
}

function normalizeAddress(value) {
  if (value === null) return null;
  const address = exactObject(value, ['line1', 'postalCode', 'city', 'countryCode'], ['line2']);
  const countryCode = boundedText(address.countryCode, 'TENANT_SITE_ADDRESS_INVALID', 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) inputError('TENANT_SITE_ADDRESS_INVALID');
  return Object.freeze({
    line1: boundedText(address.line1, 'TENANT_SITE_ADDRESS_INVALID'),
    line2: address.line2 === undefined || address.line2 === null
      ? null
      : nullableText(address.line2, 'TENANT_SITE_ADDRESS_INVALID'),
    postalCode: boundedText(address.postalCode, 'TENANT_SITE_ADDRESS_INVALID', 32),
    city: boundedText(address.city, 'TENANT_SITE_ADDRESS_INVALID', 120),
    countryCode,
  });
}

function normalizeRoom(value, roomIds, { stored = false } = {}) {
  const room = exactObject(value, [
    'id', 'siteId', 'name', 'capacity', 'active', 'floor', 'equipment', 'accessibility',
    'serviceIds', 'cateringPackageIds', 'floorplanAssetId', 'mediaAssetIds',
  ]);
  const id = safeId(room.id, 'TENANT_ROOM_ID_INVALID');
  if (roomIds.has(id)) inputError('TENANT_ROOM_ID_DUPLICATE');
  roomIds.add(id);
  const siteId = safeId(room.siteId, 'TENANT_ROOM_SITE_INVALID');
  if (!Number.isSafeInteger(room.capacity) || room.capacity < 1 || room.capacity > 100_000) {
    inputError('TENANT_ROOM_CAPACITY_INVALID');
  }
  if (typeof room.active !== 'boolean') inputError('TENANT_ROOM_ACTIVE_INVALID');
  const floorplanAssetId = room.floorplanAssetId === null
    ? null
    : assetId(room.floorplanAssetId, 'TENANT_ROOM_FLOORPLAN_INVALID');
  return Object.freeze({
    id,
    siteId,
    name: boundedText(room.name, 'TENANT_ROOM_NAME_INVALID'),
    capacity: room.capacity,
    active: room.active,
    floor: room.floor === null ? null : (stored ? boundedText : publicPresentationText)(room.floor, 'TENANT_ROOM_FLOOR_INVALID', 80),
    equipment: stringList(room.equipment, { code: 'TENANT_ROOM_EQUIPMENT_INVALID' }),
    accessibility: stringList(room.accessibility, {
      code: 'TENANT_ROOM_ACCESSIBILITY_INVALID', limit: 20,
      normalize: stored ? boundedText : publicPresentationText,
    }),
    serviceIds: idList(room.serviceIds, 'TENANT_ROOM_SERVICE_INVALID'),
    cateringPackageIds: idList(room.cateringPackageIds, 'TENANT_ROOM_CATERING_INVALID'),
    floorplanAssetId,
    mediaAssetIds: assetList(room.mediaAssetIds),
  });
}

function normalize(value, { allowUnknownTimeZones, stored = false }) {
  const root = exactObject(value, ['sites', 'rooms']);
  if (!Array.isArray(root.sites) || root.sites.length > SITE_LIMIT) inputError('TENANT_SITES_INVALID');
  if (!Array.isArray(root.rooms) || root.rooms.length > ROOM_LIMIT) inputError('TENANT_ROOMS_INVALID');
  const siteIds = new Set();
  const sites = root.sites.map((candidate) => {
    const site = exactObject(candidate, ['id', 'name', 'active', 'timeZone', 'address']);
    const id = safeId(site.id, 'TENANT_SITE_ID_INVALID');
    if (siteIds.has(id)) inputError('TENANT_SITE_ID_DUPLICATE');
    siteIds.add(id);
    if (typeof site.active !== 'boolean') inputError('TENANT_SITE_ACTIVE_INVALID');
    if (site.timeZone !== null && !isIanaTimeZone(site.timeZone)) inputError('TENANT_SITE_TIME_ZONE_INVALID');
    if (site.timeZone === null && !allowUnknownTimeZones) inputError('TENANT_SITE_TIME_ZONE_INVALID');
    return Object.freeze({
      id,
      name: boundedText(site.name, 'TENANT_SITE_NAME_INVALID'),
      active: site.active,
      timeZone: site.timeZone,
      address: normalizeAddress(site.address),
    });
  });
  const roomIds = new Set();
  const rooms = root.rooms.map((candidate) => normalizeRoom(candidate, roomIds, { stored }));
  const siteById = new Map(sites.map((site) => [site.id, site]));
  for (const room of rooms) {
    const site = siteById.get(room.siteId);
    if (!site) inputError('TENANT_ROOM_SITE_INVALID');
    if (!site.active && room.active) inputError('TENANT_INACTIVE_SITE_HAS_ACTIVE_ROOM');
  }
  if (new Set(rooms.flatMap((room) => room.serviceIds)).size > 2_000) {
    inputError('TENANT_ROOM_SERVICE_INVALID');
  }
  if (new Set(rooms.flatMap((room) => room.cateringPackageIds)).size > 2_000) {
    inputError('TENANT_ROOM_CATERING_INVALID');
  }
  return Object.freeze({ sites: Object.freeze(sites), rooms: Object.freeze(rooms) });
}

export function normalizeTenantLocations(value) {
  return normalize(value, { allowUnknownTimeZones: false });
}

export function normalizeStoredTenantLocations(value) {
  return normalize(value, { allowUnknownTimeZones: true, stored: true });
}

export function assertTenantLocationTransition(currentValue, proposedValue) {
  const current = normalizeStoredTenantLocations(currentValue);
  const proposed = normalizeTenantLocations(proposedValue);
  const proposedSiteIds = new Set(proposed.sites.map((site) => site.id));
  if (current.sites.some((site) => !proposedSiteIds.has(site.id))) inputError('TENANT_SITE_ARCHIVE_REQUIRED');
  const proposedRoomIds = new Set(proposed.rooms.map((room) => room.id));
  if (current.rooms.some((room) => !proposedRoomIds.has(room.id))) inputError('TENANT_ROOM_ARCHIVE_REQUIRED');
  const currentRoomIds = new Set(current.rooms.map((room) => room.id));
  if (proposed.rooms.some((room) => !currentRoomIds.has(room.id))) {
    inputError('TENANT_ROOM_PROVIDER_IMPORT_REQUIRED');
  }
  return proposed;
}

export function tenantLocationRollbackConfiguration(currentValue, sourceValue) {
  const current = normalizeStoredTenantLocations(currentValue);
  const source = normalizeStoredTenantLocations(sourceValue);
  const sourceSiteIds = new Set(source.sites.map((site) => site.id));
  const sourceRoomIds = new Set(source.rooms.map((room) => room.id));
  const sites = [
    ...source.sites,
    ...current.sites
      .filter((site) => !sourceSiteIds.has(site.id))
      .map((site) => Object.freeze({ ...site, active: false })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const rooms = [
    ...source.rooms,
    ...current.rooms
      .filter((room) => !sourceRoomIds.has(room.id))
      .map((room) => Object.freeze({ ...room, active: false })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  return normalizeTenantLocations({ sites, rooms });
}

// V2 adds Site-owned guest configuration without changing the exact v1 aggregate.
export function normalizeTenantLocationsV2(value, { stored = false } = {}) {
  const root = exactObject(value, ['sites', 'rooms']);
  if (!Array.isArray(root.sites) || root.sites.length > SITE_LIMIT) inputError('TENANT_SITES_INVALID');
  const guests = new Map();
  const sites = root.sites.map((candidate) => {
    const site = exactObject(candidate, ['id', 'name', 'active', 'timeZone', 'address', 'guestInformation']);
    guests.set(site.id, normalizeSiteGuestInformation(site.guestInformation));
    const { guestInformation: omitted, ...legacy } = site;
    return legacy;
  });
  const normalized = normalize({ sites, rooms: root.rooms }, { allowUnknownTimeZones: stored, stored });
  return Object.freeze({
    sites: Object.freeze(normalized.sites.map((site) => Object.freeze({
      ...site, guestInformation: guests.get(site.id),
    }))),
    rooms: normalized.rooms,
  });
}

export function tenantLocationsV1Projection(value) {
  return normalizeStoredTenantLocations({
    sites: value.sites.map(({ guestInformation, ...site }) => site),
    rooms: value.rooms,
  });
}
