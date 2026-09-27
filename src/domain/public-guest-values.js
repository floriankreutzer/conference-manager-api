const ARRIVAL = new Set(['not_available', 'reception', 'organizer']);
const AVAILABILITY = new Set(['not_available', 'available']);
const ACCESSIBILITY = new Set([
  'step_free_entry', 'lift', 'accessible_toilet', 'hearing_loop',
]);
const SITE_KEYS = ['publicTransport', 'parking', 'arrival', 'accessibilityFeatures'];
const ROOM_KEYS = ['floorNumber', 'accessibilityFeatures'];

export class PublicGuestValuesInputError extends Error {
  constructor() {
    super('PUBLIC_GUEST_VALUES_INVALID');
    this.name = 'PublicGuestValuesInputError';
    this.code = 'PUBLIC_GUEST_VALUES_INVALID';
  }
}

function invalid() {
  throw new PublicGuestValuesInputError();
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}

function features(value) {
  if (!Array.isArray(value) || value.length > ACCESSIBILITY.size
    || value.some((entry) => !ACCESSIBILITY.has(entry))
    || new Set(value).size !== value.length) invalid();
  return Object.freeze([...value].sort());
}

export function normalizePublicSiteGuestValues(value) {
  if (value === null) return null;
  const values = exact(value, SITE_KEYS);
  if (!AVAILABILITY.has(values.publicTransport) || !AVAILABILITY.has(values.parking)
    || !ARRIVAL.has(values.arrival)) invalid();
  return Object.freeze({
    publicTransport: values.publicTransport,
    parking: values.parking,
    arrival: values.arrival,
    accessibilityFeatures: features(values.accessibilityFeatures),
  });
}

export function normalizePublicRoomGuestValues(value) {
  if (value === null) return null;
  const values = exact(value, ROOM_KEYS);
  if (values.floorNumber !== null && (!Number.isSafeInteger(values.floorNumber)
    || values.floorNumber < -10 || values.floorNumber > 200)) invalid();
  return Object.freeze({
    floorNumber: values.floorNumber,
    accessibilityFeatures: features(values.accessibilityFeatures),
  });
}
