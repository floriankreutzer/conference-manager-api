const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const SENSITIVE_ENVIRONMENT_NAME =
  /_(?:DATABASE_URL|SESSION_SECRET|CSRF_SECRET|HMAC_SECRET)$/u;

function environmentEntries(variables) {
  const prototype = variables && typeof variables === 'object'
    ? Object.getPrototypeOf(variables)
    : null;
  if (
    !variables
    || typeof variables !== 'object'
    || Array.isArray(variables)
    || (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new Error('GITHUB_ACTIONS_ENVIRONMENT_INVALID');
  }
  const entries = Object.entries(variables);
  if (entries.length === 0) throw new Error('GITHUB_ACTIONS_ENVIRONMENT_INVALID');
  for (const [name, value] of entries) {
    if (
      !ENVIRONMENT_NAME.test(name)
      || typeof value !== 'string'
      || value.length === 0
      || /[\0\r\n]/u.test(value)
    ) {
      throw new Error('GITHUB_ACTIONS_ENVIRONMENT_INVALID');
    }
  }
  return entries;
}

export function encodeGitHubActionsCommandData(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('GITHUB_ACTIONS_MASK_VALUE_INVALID');
  }
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

export function registerGitHubActionsSecretMasks(
  values,
  { write = (chunk) => process.stdout.write(chunk) } = {},
) {
  if (!Array.isArray(values) || values.length === 0 || typeof write !== 'function') {
    throw new Error('GITHUB_ACTIONS_MASK_VALUES_INVALID');
  }
  const registered = new Set();
  for (const value of values) {
    const encoded = encodeGitHubActionsCommandData(value);
    if (registered.has(value)) continue;
    registered.add(value);
    write(`::add-mask::${encoded}\n`);
  }
}

export function sensitiveGitHubActionsEnvironmentValues(variables) {
  return Object.freeze(environmentEntries(variables)
    .filter(([name]) => SENSITIVE_ENVIRONMENT_NAME.test(name))
    .map(([, value]) => value));
}

export function serializeGitHubActionsEnvironment(variables) {
  return `${environmentEntries(variables)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;
}
