// Import-free value validation only; this neither issues nor verifies authority.
export function isCustomerEmailBrowserToken(value) {
  if (typeof value !== 'string' || value.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}
