const ACTION_ROLES = new Set(['employee', 'conference_manager']);
const UNSAFE_UNICODE_FORMAT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function exactObject(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  }
}

export function normalizeAttributionDisplayName(value) {
  if (typeof value !== 'string') throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  const normalized = value.normalize('NFC');
  const length = Array.from(normalized).length;
  if (
    length < 1 || length > 160
    || normalized.trim() !== normalized
    || UNSAFE_UNICODE_FORMAT.test(normalized)
  ) throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  return normalized;
}

export function normalizeAttributionSourceDisplayName(value) {
  if (typeof value !== 'string' || UNSAFE_UNICODE_FORMAT.test(value)) {
    throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  }
  return normalizeAttributionDisplayName(value.trim());
}

export function normalizeRequesterAttribution(value) {
  exactObject(value, ['displayName']);
  return Object.freeze({ displayName: normalizeAttributionDisplayName(value.displayName) });
}

export function normalizeActionAttribution(value) {
  exactObject(value, ['displayName', 'roleAtAction']);
  if (value.roleAtAction !== null && !ACTION_ROLES.has(value.roleAtAction)) {
    throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  }
  return Object.freeze({
    displayName: normalizeAttributionDisplayName(value.displayName),
    roleAtAction: value.roleAtAction,
  });
}
