const INTERNAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isInternalUuid(value) {
  return typeof value === 'string' && INTERNAL_UUID_PATTERN.test(value);
}


// Canonical 32-byte URL-safe browser values only; no issuance or authority.
export function isOpaqueBrowserToken(value) {
  if (typeof value!=='string' || value.length!==43 || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes=Buffer.from(value,'base64url');
  return bytes.length===32 && bytes.toString('base64url')===value;
}
