import { PlatformAuthorizationError } from './errors.js';

export const PLATFORM_ROLE = Object.freeze({
  SUPPORT_READER: 'platform_support_reader',
  TENANT_OPERATOR: 'platform_tenant_operator',
  SECURITY_AUDITOR: 'platform_security_auditor',
  SECURITY_ADMIN: 'platform_security_admin',
});

export const PLATFORM_PERMISSION = Object.freeze({
  TENANT_READ: 'platform:tenant:read',
  READINESS_READ: 'platform:readiness:read',
  INTEGRATION_HEALTH_READ: 'platform:integration-health:read',
  INVITATION_MANAGE: 'platform:invitation:manage',
  LIFECYCLE_MANAGE: 'platform:lifecycle:manage',
  ENTITLEMENT_READ: 'platform:entitlement:read',
  ENTITLEMENT_MANAGE: 'platform:entitlement:manage',
  QUOTA_MANAGE: 'platform:quota:manage',
  METERING_READ: 'platform:metering:read',
  RUNTIME_READ: 'platform:runtime:read',
  DIAGNOSTICS_READ: 'platform:diagnostics:read',
  DIAGNOSTICS_SENSITIVE: 'platform:diagnostics:sensitive',
  RECOVERY_EXECUTE: 'platform:recovery:execute',
  AUDIT_READ: 'platform:audit:read',
  AUDIT_EXPORT: 'platform:audit:export',
  SESSION_REVOKE: 'platform:session:revoke',
  OPERATOR_MANAGE: 'platform:operator:manage',
  BREAK_GLASS_MANAGE: 'platform:break-glass:manage',
});

const READ_PERMISSIONS = [
  PLATFORM_PERMISSION.TENANT_READ,
  PLATFORM_PERMISSION.READINESS_READ,
  PLATFORM_PERMISSION.INTEGRATION_HEALTH_READ,
  PLATFORM_PERMISSION.DIAGNOSTICS_READ,
  PLATFORM_PERMISSION.ENTITLEMENT_READ,
  PLATFORM_PERMISSION.METERING_READ,
  PLATFORM_PERMISSION.RUNTIME_READ,
];

const ROLE_PERMISSIONS = Object.freeze({
  [PLATFORM_ROLE.SUPPORT_READER]: READ_PERMISSIONS,
  [PLATFORM_ROLE.TENANT_OPERATOR]: [
    ...READ_PERMISSIONS,
    PLATFORM_PERMISSION.INVITATION_MANAGE,
    PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
    PLATFORM_PERMISSION.ENTITLEMENT_MANAGE,
    PLATFORM_PERMISSION.QUOTA_MANAGE,
  ],
  [PLATFORM_ROLE.SECURITY_AUDITOR]: [
    PLATFORM_PERMISSION.TENANT_READ,
    PLATFORM_PERMISSION.DIAGNOSTICS_READ,
    PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE,
    PLATFORM_PERMISSION.AUDIT_READ,
    PLATFORM_PERMISSION.AUDIT_EXPORT,
    PLATFORM_PERMISSION.RUNTIME_READ,
  ],
  [PLATFORM_ROLE.SECURITY_ADMIN]: [
    PLATFORM_PERMISSION.TENANT_READ,
    PLATFORM_PERMISSION.DIAGNOSTICS_READ,
    PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE,
    PLATFORM_PERMISSION.RECOVERY_EXECUTE,
    PLATFORM_PERMISSION.AUDIT_READ,
    PLATFORM_PERMISSION.SESSION_REVOKE,
    PLATFORM_PERMISSION.OPERATOR_MANAGE,
    PLATFORM_PERMISSION.BREAK_GLASS_MANAGE,
  ],
});

const KNOWN_ROLES = new Set(Object.values(PLATFORM_ROLE));
const KNOWN_PERMISSIONS = new Set(Object.values(PLATFORM_PERMISSION));
const STEP_UP_PERMISSIONS = new Set([
  PLATFORM_PERMISSION.INVITATION_MANAGE,
  PLATFORM_PERMISSION.LIFECYCLE_MANAGE,
  PLATFORM_PERMISSION.ENTITLEMENT_MANAGE,
  PLATFORM_PERMISSION.QUOTA_MANAGE,
  PLATFORM_PERMISSION.DIAGNOSTICS_SENSITIVE,
  PLATFORM_PERMISSION.RECOVERY_EXECUTE,
  PLATFORM_PERMISSION.AUDIT_EXPORT,
  PLATFORM_PERMISSION.SESSION_REVOKE,
  PLATFORM_PERMISSION.OPERATOR_MANAGE,
  PLATFORM_PERMISSION.BREAK_GLASS_MANAGE,
]);

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

export function permissionsForPlatformRoles(roles) {
  if (!Array.isArray(roles) || roles.length < 1 || roles.length > 4) {
    throw new TypeError('PLATFORM_ROLES_INVALID');
  }
  if (roles.some((role) => typeof role !== 'string' || !KNOWN_ROLES.has(role))) {
    throw new TypeError('PLATFORM_ROLES_INVALID');
  }
  if (new Set(roles).size !== roles.length) throw new TypeError('PLATFORM_ROLES_INVALID');
  return Object.freeze(sortedUnique(roles.flatMap((role) => ROLE_PERMISSIONS[role])));
}

export function isKnownPlatformPermission(permission) {
  return KNOWN_PERMISSIONS.has(permission);
}

export function platformPermissionRequiresStepUp(permission) {
  if (!KNOWN_PERMISSIONS.has(permission)) throw new TypeError('PLATFORM_PERMISSION_INVALID');
  return STEP_UP_PERMISSIONS.has(permission);
}

export function createPlatformAuthorizationPolicy({ clock = () => Date.now() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_CLOCK_REQUIRED');

  function authorize(principal, permission) {
    if (!KNOWN_PERMISSIONS.has(permission)) throw new TypeError('PLATFORM_PERMISSION_INVALID');
    if (!principal || !Array.isArray(principal.permissions) || !principal.permissions.includes(permission)) {
      throw new PlatformAuthorizationError();
    }
    if (principal.assurance?.level !== 'mfa' && principal.assurance?.level !== 'step_up') {
      throw new PlatformAuthorizationError('PLATFORM_MFA_REQUIRED');
    }
    if (STEP_UP_PERMISSIONS.has(permission)) {
      const expiresAt = principal.session?.stepUpExpiresAt;
      if (
        principal.assurance.level !== 'step_up'
        || typeof expiresAt !== 'string'
        || !expiresAt.endsWith('Z')
        || Date.parse(expiresAt) <= clock()
      ) {
        throw new PlatformAuthorizationError('PLATFORM_STEP_UP_REQUIRED');
      }
    }
    return true;
  }

  return Object.freeze({
    authorize,
    can(principal, permission) {
      try {
        return authorize(principal, permission);
      } catch (error) {
        if (error instanceof PlatformAuthorizationError) return false;
        throw error;
      }
    },
  });
}
