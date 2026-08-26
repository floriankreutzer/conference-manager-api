export const TENANT_CONFIGURATION_DOMAIN = Object.freeze({
  ORGANIZATION: 'organization',
  LOCATIONS: 'locations',
  CATALOG: 'catalog',
  BOOKING_POLICIES: 'booking_policies',
  COST_ALLOCATION: 'cost_allocation',
});

export const TENANT_CONFIGURATION_CHANGE_KIND = Object.freeze({
  INITIAL: 'initial',
  UPDATE: 'update',
  ROLLBACK: 'rollback',
  IMPORT: 'import',
});

const DOMAINS = new Set(Object.values(TENANT_CONFIGURATION_DOMAIN));
const CHANGE_KINDS = new Set(Object.values(TENANT_CONFIGURATION_CHANGE_KIND));
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 5_000;
const MAX_OBJECT_KEYS = 500;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_KEY_LENGTH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class TenantConfigurationInputError extends Error {
  constructor(code = 'TENANT_CONFIGURATION_INVALID') {
    super(code);
    this.name = 'TenantConfigurationInputError';
    this.code = code;
  }
}

export class TenantConfigurationConflictError extends Error {
  constructor(currentRevision, code = 'TENANT_CONFIGURATION_REVISION_CONFLICT') {
    super(code);
    this.name = 'TenantConfigurationConflictError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export class TenantConfigurationNotFoundError extends Error {
  constructor(code = 'TENANT_CONFIGURATION_REVISION_NOT_FOUND') {
    super(code);
    this.name = 'TenantConfigurationNotFoundError';
    this.code = code;
  }
}

function inputError(code) {
  throw new TenantConfigurationInputError(code);
}

export function requireTenantConfigurationDomain(value) {
  if (typeof value !== 'string' || !DOMAINS.has(value)) {
    inputError('TENANT_CONFIGURATION_DOMAIN_INVALID');
  }
  return value;
}

export function requireTenantConfigurationChangeKind(value) {
  if (typeof value !== 'string' || !CHANGE_KINDS.has(value)) {
    inputError('TENANT_CONFIGURATION_CHANGE_KIND_INVALID');
  }
  return value;
}

export function requireRevision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    inputError('TENANT_CONFIGURATION_REVISION_INVALID');
  }
  return parsed;
}

export function requireExpectedRevision(value) {
  return requireRevision(value, { allowZero: true });
}

export function requireHistoryLimit(value = 50) {
  const parsed = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    inputError('TENANT_CONFIGURATION_HISTORY_LIMIT_INVALID');
  }
  return parsed;
}

function validateJsonValue(value, depth, state) {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    inputError('TENANT_CONFIGURATION_SNAPSHOT_TOO_COMPLEX');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) inputError('TENANT_CONFIGURATION_SNAPSHOT_TOO_COMPLEX');
    value.forEach((entry) => validateJsonValue(entry, depth + 1, state));
    return;
  }
  if (typeof value !== 'object') inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_OBJECT_KEYS) inputError('TENANT_CONFIGURATION_SNAPSHOT_TOO_COMPLEX');
  for (const key of keys) {
    if (
      key.length < 1
      || key.length > MAX_KEY_LENGTH
      || CONTROL_CHARACTER.test(key)
      || FORBIDDEN_KEYS.has(key)
    ) {
      inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
    }
    validateJsonValue(value[key], depth + 1, state);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

export function requireConfigurationSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
  }
  validateJsonValue(value, 0, { nodes: 0 });
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    inputError('TENANT_CONFIGURATION_SNAPSHOT_INVALID');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
    inputError('TENANT_CONFIGURATION_SNAPSHOT_TOO_LARGE');
  }
  return deepFreeze(JSON.parse(serialized));
}

export function exactObject(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    inputError('TENANT_CONFIGURATION_INVALID');
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) {
    inputError('TENANT_CONFIGURATION_INVALID');
  }
  return value;
}

export function boundedText(value, {
  minimum = 0,
  maximum,
  code = 'TENANT_CONFIGURATION_INVALID',
} = {}) {
  if (typeof value !== 'string') inputError(code);
  const normalized = value.trim();
  if (
    !Number.isSafeInteger(maximum)
    || normalized.length < minimum
    || normalized.length > maximum
    || CONTROL_CHARACTER.test(normalized)
  ) {
    inputError(code);
  }
  return normalized;
}

export function nullableBoundedText(value, options) {
  return value === null || value === undefined ? null : boundedText(value, options);
}

export function safeIdentifier(value, code = 'TENANT_CONFIGURATION_IDENTIFIER_INVALID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    inputError(code);
  }
  return value;
}

export function uniqueStringList(value, {
  limit,
  itemMaximum = 80,
  code = 'TENANT_CONFIGURATION_INVALID',
} = {}) {
  if (!Array.isArray(value) || value.length > limit) inputError(code);
  const seen = new Set();
  const normalized = value.map((item) => boundedText(item, {
    minimum: 1,
    maximum: itemMaximum,
    code,
  }));
  for (const item of normalized) {
    if (seen.has(item)) inputError(code);
    seen.add(item);
  }
  return Object.freeze(normalized);
}

export function approvedValue(value, allowed, code = 'TENANT_CONFIGURATION_INVALID') {
  if (typeof value !== 'string' || !allowed.has(value)) inputError(code);
  return value;
}

export function boundedInteger(value, {
  minimum,
  maximum,
  code = 'TENANT_CONFIGURATION_INVALID',
} = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) inputError(code);
  return value;
}
