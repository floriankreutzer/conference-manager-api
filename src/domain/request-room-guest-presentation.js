const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DETAIL_KEYS = new Set([
  'floor', 'equipment', 'accessibility', 'serviceIds', 'cateringPackageIds',
  'floorplanAssetId', 'mediaAssetIds',
]);

function invalid() {
  throw new TypeError('REQUEST_ROOM_GUEST_PRESENTATION_INVALID');
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

export function publicGuestRoomFields(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)
    || Object.keys(details).some((key) => !DETAIL_KEYS.has(key))) invalid();
  // Historic free text stays private even if it contains an unsafe value.
  // Do not validate or reflect it while projecting public Guest context.
  return Object.freeze({
    // v2 free prose is stored for authorized editors, but never made public.
    floor: null,
    accessibility: Object.freeze([]),
    floorplanAssetId: details.floorplanAssetId === null || details.floorplanAssetId === undefined
      ? null : asset(details.floorplanAssetId),
    mediaAssetIds: list(details.mediaAssetIds ?? [], asset),
  });
}
