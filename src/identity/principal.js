import { isInternalUuid } from '../domain/identifiers.js';

const ROLE_PATTERN = /^[a-z][a-z0-9:_-]{1,63}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9:_-]{1,127}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function normalizeStringSet(value, { pattern, min, max, code }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new TypeError(code);
  }
  if (value.some((entry) => typeof entry !== 'string' || !pattern.test(entry))) {
    throw new TypeError(code);
  }
  return Object.freeze([...new Set(value)]);
}

function normalizeProviderIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PROVIDER_IDENTITY_INVALID');
  }
  const { provider, reference } = value;
  if (typeof provider !== 'string' || !PROVIDER_PATTERN.test(provider)) {
    throw new TypeError('PROVIDER_IDENTITY_INVALID');
  }
  if (
    typeof reference !== 'string'
    || reference.length < 1
    || reference.length > 255
    || reference.trim() !== reference
    || /[\u0000-\u001f\u007f]/.test(reference)
  ) {
    throw new TypeError('PROVIDER_IDENTITY_INVALID');
  }
  return Object.freeze({ provider, reference });
}

function normalizeIdentityCore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PRINCIPAL_INVALID');
  }
  if (!isInternalUuid(value.userId) || !isInternalUuid(value.tenantId)) {
    throw new TypeError('PRINCIPAL_INVALID');
  }
  return Object.freeze({
    userId: value.userId,
    tenantId: value.tenantId,
    providerIdentity: normalizeProviderIdentity(value.providerIdentity),
    roles: normalizeStringSet(value.roles, {
      pattern: ROLE_PATTERN,
      min: 1,
      max: 16,
      code: 'ROLES_INVALID',
    }),
    permissions: normalizeStringSet(value.permissions || [], {
      pattern: PERMISSION_PATTERN,
      min: 0,
      max: 64,
      code: 'PERMISSIONS_INVALID',
    }),
  });
}

function normalizeUtcInstant(value, code) {
  if (typeof value !== 'string' || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(code);
  }
  return value;
}

export function normalizeTrustedIdentity(value) {
  const core = normalizeIdentityCore(value);
  if (!Number.isSafeInteger(value.securityVersion) || value.securityVersion < 1) {
    throw new TypeError('IDENTITY_SECURITY_VERSION_INVALID');
  }
  return Object.freeze({
    ...core,
    securityVersion: value.securityVersion,
  });
}

export function normalizePrincipal(value) {
  const core = normalizeIdentityCore(value);
  const session = value.session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new TypeError('SESSION_METADATA_INVALID');
  }
  if (!isInternalUuid(session.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1) {
    throw new TypeError('SESSION_METADATA_INVALID');
  }
  const issuedAt = normalizeUtcInstant(session.issuedAt, 'SESSION_METADATA_INVALID');
  const expiresAt = normalizeUtcInstant(session.expiresAt, 'SESSION_METADATA_INVALID');
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw new TypeError('SESSION_METADATA_INVALID');

  return Object.freeze({
    ...core,
    session: Object.freeze({
      id: session.id,
      issuedAt,
      expiresAt,
      securityVersion: session.securityVersion,
    }),
  });
}
