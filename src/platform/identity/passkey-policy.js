// A reduced key minimum is an explicit INT-only operating decision. Other
// environments and every omitted configuration retain the two-key default.
export function requirePlatformPasskeyMinimum(environment, count = 2) {
  if (!['dev','int','prod'].includes(environment) || ![1,2].includes(count)
    || count === 1 && environment !== 'int') {
    throw new TypeError('PLATFORM_PASSKEY_MINIMUM_INVALID');
  }
  return count;
}
