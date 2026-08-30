import { isInternalUuid } from '../../domain/identifiers.js';
import { permissionsForPlatformRoles } from './policy.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/;
const AUTHENTICATION_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function utcInstant(value, code) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (
    !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value
  ) {
    throw new TypeError(code);
  }
  return value;
}

function providerIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PLATFORM_PROVIDER_IDENTITY_INVALID');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'provider,subjectReference,tenantReference') {
    throw new TypeError('PLATFORM_PROVIDER_IDENTITY_INVALID');
  }
  if (
    typeof value.provider !== 'string'
    || !PROVIDER_PATTERN.test(value.provider)
    || typeof value.tenantReference !== 'string'
    || !REFERENCE_PATTERN.test(value.tenantReference)
    || typeof value.subjectReference !== 'string'
    || !REFERENCE_PATTERN.test(value.subjectReference)
  ) {
    throw new TypeError('PLATFORM_PROVIDER_IDENTITY_INVALID');
  }
  return Object.freeze({
    provider: value.provider,
    tenantReference: value.tenantReference,
    subjectReference: value.subjectReference,
  });
}

function assurance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PLATFORM_ASSURANCE_INVALID');
  }
  if (
    Object.keys(value).sort().join(',') !== 'authenticatedAt,authenticationContext,level'
    ||
    !['mfa', 'step_up'].includes(value.level)
    || typeof value.authenticationContext !== 'string'
    || !AUTHENTICATION_CONTEXT_PATTERN.test(value.authenticationContext)
  ) {
    throw new TypeError('PLATFORM_ASSURANCE_INVALID');
  }
  return Object.freeze({
    level: value.level,
    authenticationContext: value.authenticationContext,
    authenticatedAt: utcInstant(value.authenticatedAt, 'PLATFORM_ASSURANCE_INVALID'),
  });
}

function targetScope(value, securityVersion) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'mode,securityVersion'
    || !['all', 'allowlist'].includes(value.mode)
    || !Number.isSafeInteger(value.securityVersion)
    || value.securityVersion !== securityVersion
  ) throw new TypeError('PLATFORM_TARGET_SCOPE_INVALID');
  return Object.freeze({ mode: value.mode, securityVersion: value.securityVersion });
}

function identityCore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !isInternalUuid(value.operatorId)) {
    throw new TypeError('PLATFORM_PRINCIPAL_INVALID');
  }
  const roles = Array.isArray(value.roles) ? Object.freeze([...value.roles].sort()) : value.roles;
  const expectedPermissions = permissionsForPlatformRoles(roles);
  if (
    !Array.isArray(value.permissions)
    || value.permissions.length !== expectedPermissions.length
    || value.permissions.some((permission, index) => permission !== expectedPermissions[index])
  ) {
    throw new TypeError('PLATFORM_PERMISSIONS_INVALID');
  }
  if (!Number.isSafeInteger(value.securityVersion) || value.securityVersion < 1) {
    throw new TypeError('PLATFORM_SECURITY_VERSION_INVALID');
  }
  return Object.freeze({
    operatorId: value.operatorId,
    providerIdentity: providerIdentity(value.providerIdentity),
    roles,
    permissions: expectedPermissions,
    securityVersion: value.securityVersion,
    targetScope: targetScope(value.targetScope, value.securityVersion),
    assurance: assurance(value.assurance),
  });
}

export function normalizeTrustedPlatformIdentity(value) {
  if (
    !value
    || Object.keys(value).sort().join(',') !== 'assurance,operatorId,permissions,providerIdentity,roles,securityVersion,targetScope'
  ) throw new TypeError('PLATFORM_IDENTITY_FIELDS_INVALID');
  return identityCore(value);
}

export function normalizePlatformPrincipal(value) {
  if (
    !value
    || Object.keys(value).sort().join(',') !== 'assurance,operatorId,permissions,providerIdentity,roles,securityVersion,session,targetScope'
  ) throw new TypeError('PLATFORM_PRINCIPAL_FIELDS_INVALID');
  const core = identityCore(value);
  const session = value.session;
  if (!session || typeof session !== 'object' || Array.isArray(session) || !isInternalUuid(session.id)) {
    throw new TypeError('PLATFORM_SESSION_METADATA_INVALID');
  }
  if (
    Object.keys(session).sort().join(',')
    !== 'expiresAt,id,issuedAt,securityEpoch,securityVersion,stepUpExpiresAt'
  ) throw new TypeError('PLATFORM_SESSION_METADATA_INVALID');
  if (
    !Number.isSafeInteger(session.securityVersion)
    || session.securityVersion !== core.securityVersion
    || !Number.isSafeInteger(session.securityEpoch)
    || session.securityEpoch < 1
  ) {
    throw new TypeError('PLATFORM_SESSION_METADATA_INVALID');
  }
  const issuedAt = utcInstant(session.issuedAt, 'PLATFORM_SESSION_METADATA_INVALID');
  const expiresAt = utcInstant(session.expiresAt, 'PLATFORM_SESSION_METADATA_INVALID');
  const stepUpExpiresAt = session.stepUpExpiresAt === null
    ? null
    : utcInstant(session.stepUpExpiresAt, 'PLATFORM_SESSION_METADATA_INVALID');
  if (
    Date.parse(expiresAt) <= Date.parse(issuedAt)
    || Date.parse(core.assurance.authenticatedAt) > Date.parse(issuedAt) + 60_000
    || (core.assurance.level === 'step_up' && stepUpExpiresAt === null)
    || (core.assurance.level === 'mfa' && stepUpExpiresAt !== null)
    || (stepUpExpiresAt !== null && (
      Date.parse(stepUpExpiresAt) <= Date.parse(issuedAt)
      || Date.parse(stepUpExpiresAt) > Date.parse(expiresAt)
      || Date.parse(stepUpExpiresAt) > Date.parse(core.assurance.authenticatedAt) + (5 * 60 * 1000)
    ))
  ) {
    throw new TypeError('PLATFORM_SESSION_METADATA_INVALID');
  }
  return Object.freeze({
    ...core,
    session: Object.freeze({
      id: session.id,
      issuedAt,
      expiresAt,
      securityVersion: session.securityVersion,
      securityEpoch: session.securityEpoch,
      stepUpExpiresAt,
    }),
  });
}
