const ADDRESS_KEYS = Object.freeze(['line1', 'line2', 'postalCode', 'city', 'countryCode']);

function safeText(value, maximum) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
    || /[<>]/.test(value)
  ) return null;
  return value;
}

function publicAddress(details) {
  const value = details && typeof details === 'object' && !Array.isArray(details)
    ? details.address
    : null;
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !ADDRESS_KEYS.includes(key))) return null;
  const line1 = safeText(value.line1, 160);
  const line2 = value.line2 === null ? null : safeText(value.line2, 160);
  const postalCode = safeText(value.postalCode, 32);
  const city = safeText(value.city, 120);
  const countryCode = safeText(value.countryCode, 2);
  if (!line1 || (value.line2 !== null && !line2) || !postalCode || !city || !/^[A-Z]{2}$/.test(countryCode || '')) {
    return null;
  }
  return Object.freeze({ line1, line2, postalCode, city, countryCode });
}

function publicAccessibility(details) {
  const value = details && typeof details === 'object' && !Array.isArray(details)
    ? details.accessibility
    : null;
  if (!Array.isArray(value) || value.length > 20) return Object.freeze([]);
  const normalized = value.map((entry) => safeText(entry, 80));
  if (normalized.some((entry) => entry === null) || new Set(normalized).size !== normalized.length) {
    return Object.freeze([]);
  }
  return Object.freeze(normalized);
}

export function publicGuestRoomFields({ roomDetails, siteDetails } = {}) {
  return Object.freeze({
    accessibility: publicAccessibility(roomDetails),
    address: publicAddress(siteDetails),
  });
}
