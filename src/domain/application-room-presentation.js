const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEXT_MAX = 160;
const EQUIPMENT_LIMIT = 100;
const MEDIA_LIMIT = 20;
const ROOM_DETAIL_KEYS = new Set([
  'description',
  'floor',
  'equipment',
  'accessibility',
  'serviceIds',
  'cateringPackageIds',
  'floorplanAssetId',
  'mediaAssetIds',
]);

function storedDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !ROOM_DETAIL_KEYS.has(key))) return null;
  return value;
}

function safeEquipment(value) {
  if (!Array.isArray(value) || value.length > EQUIPMENT_LIMIT) return Object.freeze([]);
  const normalized = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string'
      || entry.length < 1
      || entry.length > TEXT_MAX
      || entry !== entry.trim()
      || /[\u0000-\u001f\u007f]/.test(entry)
      || normalized.includes(entry)
    ) return Object.freeze([]);
    normalized.push(entry);
  }
  return Object.freeze(normalized);
}

function safeAssetId(value) {
  return typeof value === 'string' && ASSET_ID.test(value) ? value : null;
}

function safeMediaAssetIds(value) {
  if (!Array.isArray(value) || value.length > MEDIA_LIMIT) return Object.freeze([]);
  const normalized = value.map(safeAssetId);
  if (normalized.some((entry) => entry === null) || new Set(normalized).size !== normalized.length) {
    return Object.freeze([]);
  }
  return Object.freeze(normalized);
}

export function publicApplicationRoom(row) {
  const details = storedDetails(row?.details);
  return Object.freeze({
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    capacity: row.capacity,
    active: row.active,
    price: row.price === null ? null : Object.freeze({ ...row.price }),
    equipment: details ? safeEquipment(details.equipment ?? []) : Object.freeze([]),
    floorplanAssetId: details ? safeAssetId(details.floorplanAssetId) : null,
    mediaAssetIds: details ? safeMediaAssetIds(details.mediaAssetIds ?? []) : Object.freeze([]),
  });
}
