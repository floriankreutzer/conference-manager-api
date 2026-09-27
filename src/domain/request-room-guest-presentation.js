import { hasUnsafeGuestRoomText } from './site-guest-information.js';
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DETAIL_KEYS = new Set([
  'floor', 'equipment', 'accessibility', 'serviceIds', 'cateringPackageIds',
  'floorplanAssetId', 'mediaAssetIds',
]);

function invalid() {
  throw new TypeError('REQUEST_ROOM_GUEST_PRESENTATION_INVALID');
}

function text(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.trim() !== value || hasUnsafeGuestRoomText(value)) invalid();
  return value;
}

function asset(value) {
  if (typeof value !== 'string' || !ASSET_ID.test(value)) invalid();
  return value;
}

function list(value, normalize) {
  if (!Array.isArray(value) || value.length > 20) invalid();
  const result = value.map(normalize);
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}

export function publicGuestRoomFields(details, { legacyValidation = true } = {}) {
  if (!details || typeof details !== 'object' || Array.isArray(details)
    || Object.keys(details).some((key) => !DETAIL_KEYS.has(key))) invalid();
  // Keep the legacy v2 rejection behavior; v3 withholds arbitrary historic prose.
  if (legacyValidation) {
    if (details.floor !== null && details.floor !== undefined) text(details.floor, 80);
    list(details.accessibility ?? [], (value) => text(value, 80));
  }
  return Object.freeze({
    // v2 free prose is stored for authorized editors, but never made public.
    floor: null,
    accessibility: Object.freeze([]),
    floorplanAssetId: details.floorplanAssetId === null || details.floorplanAssetId === undefined
      ? null : asset(details.floorplanAssetId),
    mediaAssetIds: list(details.mediaAssetIds ?? [], asset),
  });
}
