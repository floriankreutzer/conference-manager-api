import {
  REQUEST_STATUS,
  REQUEST_TRANSITION,
  isRequestTransition,
} from '../domain/request-workflow.js';
import {
  AuthorizationDeniedError,
  AuthorizationInputError,
  RequestStateConflictError,
} from './errors.js';

export { REQUEST_STATUS, REQUEST_TRANSITION } from '../domain/request-workflow.js';

export const TENANT_ROLE = Object.freeze({
  EMPLOYEE: 'employee',
  CONFERENCE_MANAGER: 'conference_manager',
  TENANT_ADMIN: 'tenant_admin',
});

export const PERMISSION = Object.freeze({
  REQUEST_READ: 'request:read',
  REQUEST_CANCEL: 'request:cancel',
  REQUEST_MANAGE: 'request:manage',
  TENANT_CONFIGURE: 'tenant:configure',
  TENANT_USERS_MANAGE: 'tenant:users:manage',
  TENANT_INTEGRATIONS_MANAGE: 'tenant:integrations:manage',
});

const ROLE_PERMISSIONS = Object.freeze({
  [TENANT_ROLE.EMPLOYEE]: Object.freeze([
    PERMISSION.REQUEST_READ,
    PERMISSION.REQUEST_CANCEL,
  ]),
  [TENANT_ROLE.CONFERENCE_MANAGER]: Object.freeze([
    PERMISSION.REQUEST_READ,
    PERMISSION.REQUEST_MANAGE,
  ]),
  [TENANT_ROLE.TENANT_ADMIN]: Object.freeze([
    PERMISSION.TENANT_CONFIGURE,
    PERMISSION.TENANT_USERS_MANAGE,
    PERMISSION.TENANT_INTEGRATIONS_MANAGE,
  ]),
});

const KNOWN_ROLES = new Set(Object.keys(ROLE_PERMISSIONS));
const KNOWN_PERMISSIONS = new Set(Object.values(PERMISSION));
const MANAGER_TRANSITIONS = Object.freeze({
  [REQUEST_TRANSITION.START_REVIEW]: Object.freeze({
    from: Object.freeze([REQUEST_STATUS.SUBMITTED]),
    to: REQUEST_STATUS.IN_REVIEW,
    reason: 'forbidden',
  }),
  [REQUEST_TRANSITION.CONFIRM]: Object.freeze({
    from: Object.freeze([REQUEST_STATUS.SUBMITTED, REQUEST_STATUS.IN_REVIEW]),
    to: REQUEST_STATUS.CONFIRMED,
    reason: 'forbidden',
  }),
  [REQUEST_TRANSITION.REJECT]: Object.freeze({
    from: Object.freeze([REQUEST_STATUS.SUBMITTED, REQUEST_STATUS.IN_REVIEW]),
    to: REQUEST_STATUS.REJECTED,
    reason: 'required',
  }),
  [REQUEST_TRANSITION.REQUEST_CHANGE]: Object.freeze({
    from: Object.freeze([REQUEST_STATUS.SUBMITTED, REQUEST_STATUS.IN_REVIEW]),
    to: REQUEST_STATUS.CHANGE_REQUESTED,
    reason: 'required',
  }),
});
const EMPLOYEE_CANCEL_FROM = new Set([
  REQUEST_STATUS.SUBMITTED,
  REQUEST_STATUS.IN_REVIEW,
  REQUEST_STATUS.CONFIRMED,
  REQUEST_STATUS.CHANGE_REQUESTED,
]);

function deny(code = 'AUTHORIZATION_DENIED', options) {
  throw new AuthorizationDeniedError(code, options);
}

function assertPrincipalShape(principal) {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) deny('PRINCIPAL_NOT_AUTHORIZED');
  if (!Array.isArray(principal.roles) || principal.roles.length === 0 || !Array.isArray(principal.permissions)) {
    deny('PRINCIPAL_NOT_AUTHORIZED');
  }
  if (principal.roles.some((role) => !KNOWN_ROLES.has(role))) deny('ROLE_NOT_AUTHORIZED');
  if (principal.permissions.some((permission) => !KNOWN_PERMISSIONS.has(permission))) {
    deny('PERMISSION_NOT_AUTHORIZED');
  }
}

function rolesAllowPermission(principal, permission, roles) {
  return principal.roles.some((role) => {
    return roles.includes(role) && ROLE_PERMISSIONS[role].includes(permission);
  });
}

function requirePermission(principal, permission, roles) {
  assertPrincipalShape(principal);
  if (!principal.permissions.includes(permission) || !rolesAllowPermission(principal, permission, roles)) {
    deny('PERMISSION_REQUIRED');
  }
}

function assertTenantBinding(principal, tenantContext, resourceTenantId) {
  if (!tenantContext || tenantContext.tenantId !== principal.tenantId) deny('TENANT_SCOPE_INVALID');
  if (resourceTenantId !== undefined && resourceTenantId !== principal.tenantId) {
    deny('RESOURCE_NOT_AVAILABLE', { conceal: true });
  }
}

function normalizeReason(value, requirement) {
  if (requirement === 'forbidden') {
    if (value !== undefined) throw new AuthorizationInputError('TRANSITION_REASON_NOT_ALLOWED');
    return null;
  }
  if (typeof value !== 'string') throw new AuthorizationInputError('TRANSITION_REASON_REQUIRED');
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 1000 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new AuthorizationInputError('TRANSITION_REASON_INVALID');
  }
  return normalized;
}

function managerTransition(principal, request, transition, reason) {
  const rule = MANAGER_TRANSITIONS[transition];
  if (!rule) return null;
  requirePermission(principal, PERMISSION.REQUEST_MANAGE, [TENANT_ROLE.CONFERENCE_MANAGER]);
  if (!rule.from.includes(request.status)) throw new RequestStateConflictError();
  return Object.freeze({
    transition,
    expectedStatus: request.status,
    nextStatus: rule.to,
    reason: normalizeReason(reason, rule.reason),
  });
}

function employeeCancellation(principal, request, transition, reason) {
  if (transition !== REQUEST_TRANSITION.CANCEL) return null;
  requirePermission(principal, PERMISSION.REQUEST_CANCEL, [TENANT_ROLE.EMPLOYEE]);
  if (request.requesterUserId !== principal.userId) deny('RESOURCE_NOT_AVAILABLE', { conceal: true });
  if (!EMPLOYEE_CANCEL_FROM.has(request.status)) throw new RequestStateConflictError();
  return Object.freeze({
    transition,
    expectedStatus: request.status,
    nextStatus: REQUEST_STATUS.CANCELLED,
    reason: normalizeReason(reason, 'forbidden'),
  });
}

export function createAuthorizationPolicy() {
  return Object.freeze({
    assertRecognizedPrincipal(principal) {
      assertPrincipalShape(principal);
      return principal;
    },

    requireTenantPermission(principal, tenantContext, permission) {
      assertTenantBinding(principal, tenantContext);
      requirePermission(principal, permission, [TENANT_ROLE.TENANT_ADMIN]);
      return true;
    },

    authorizeRequestRead(principal, tenantContext, request) {
      assertPrincipalShape(principal);
      assertTenantBinding(principal, tenantContext, request?.tenantId);
      if (!request || typeof request !== 'object') deny('RESOURCE_NOT_AVAILABLE', { conceal: true });

      if (
        principal.roles.includes(TENANT_ROLE.CONFERENCE_MANAGER)
        && principal.permissions.includes(PERMISSION.REQUEST_READ)
      ) {
        requirePermission(principal, PERMISSION.REQUEST_READ, [TENANT_ROLE.CONFERENCE_MANAGER]);
        return true;
      }

      requirePermission(principal, PERMISSION.REQUEST_READ, [TENANT_ROLE.EMPLOYEE]);
      if (request.requesterUserId !== principal.userId) deny('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return true;
    },

    authorizeRequestTransition(principal, tenantContext, request, transition, reason) {
      assertPrincipalShape(principal);
      assertTenantBinding(principal, tenantContext, request?.tenantId);
      if (!request || typeof request !== 'object') deny('RESOURCE_NOT_AVAILABLE', { conceal: true });
      if (!isRequestTransition(transition)) throw new AuthorizationInputError('TRANSITION_INVALID');

      const managerDecision = managerTransition(principal, request, transition, reason);
      if (managerDecision) return managerDecision;
      const employeeDecision = employeeCancellation(principal, request, transition, reason);
      if (employeeDecision) return employeeDecision;
      deny('TRANSITION_NOT_AUTHORIZED');
    },
  });
}
