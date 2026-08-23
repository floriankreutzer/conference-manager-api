const INTERNAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isInternalUuid(value) {
  return typeof value === 'string' && INTERNAL_UUID_PATTERN.test(value);
}
