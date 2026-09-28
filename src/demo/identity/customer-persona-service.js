import {
  TENANT_ROLE,
  tenantAuthorizationSnapshot,
} from '../../authorization/policy.js';
import { hasSessionCookie } from '../../identity/session-cookie.js';
import { DEMO_FIXTURE } from '../fixture.js';

const PERSONA_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DUAL_ROLE_PERSONA = 'dual_role';
const ALLOWED_PERSONAS = new Set([
  ...DEMO_FIXTURE.customerPersonas.map(({ persona }) => persona),
  DUAL_ROLE_PERSONA,
]);
const DUAL_ROLE_ROLES = Object.freeze([
  TENANT_ROLE.EMPLOYEE,
  TENANT_ROLE.CONFERENCE_MANAGER,
  TENANT_ROLE.TENANT_ADMIN,
]);

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function trustedIdentity(selection) {
  const authorization = tenantAuthorizationSnapshot(selection.roles);
  return Object.freeze({
    tenantId: selection.tenantId,
    userId: selection.userId,
    providerIdentity: selection.providerIdentity,
    roles: authorization.roles,
    permissions: authorization.permissions,
    securityVersion: selection.securityVersion,
  });
}

function dualRoleSelection(selection) {
  return Object.freeze({
    ...selection,
    persona: DUAL_ROLE_PERSONA,
    roles: DUAL_ROLE_ROLES,
  });
}

function hasDualRole(principal) {
  return principal?.roles?.includes(TENANT_ROLE.CONFERENCE_MANAGER)
    && principal.roles.includes(TENANT_ROLE.TENANT_ADMIN);
}

function selectionMatchesPrincipal(selection, principal) {
  const authority = trustedIdentity(selection);
  return authority.tenantId === principal.tenantId
    && authority.userId === principal.userId
    && authority.securityVersion === principal.session.securityVersion
    && sameValues(authority.roles, principal.roles)
    && sameValues(authority.permissions, principal.permissions)
    && authority.providerIdentity.provider === principal.providerIdentity.provider
    && authority.providerIdentity.reference === principal.providerIdentity.reference;
}

function validatePersona(persona) {
  if (typeof persona !== 'string' || !PERSONA_PATTERN.test(persona) || !ALLOWED_PERSONAS.has(persona)) {
    throw new TypeError('DEMO_CUSTOMER_CONTEXT_INVALID');
  }
}

function validateTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !TENANT_ID_PATTERN.test(tenantId)) {
    throw new TypeError('DEMO_CUSTOMER_CONTEXT_INVALID');
  }
}

export function createDemoCustomerPersonaService({
  sessionService,
  personaRepository,
  defaultTenantId = null,
  defaultPersona = 'employee',
} = {}) {
  if (
    !sessionService
    || typeof sessionService.issue !== 'function'
    || typeof sessionService.resolvePrincipal !== 'function'
    || typeof sessionService.revoke !== 'function'
    || typeof sessionService.csrfTokenForPrincipal !== 'function'
    || typeof sessionService.clearCookie !== 'function'
  ) throw new TypeError('DEMO_CUSTOMER_SESSION_SERVICE_REQUIRED');
  if (
    !personaRepository
    || typeof personaRepository.listTenants !== 'function'
    || typeof personaRepository.findCustomer !== 'function'
    || typeof personaRepository.findCustomerForPrincipal !== 'function'
    || typeof personaRepository.findDefaultCustomer !== 'function'
  ) throw new TypeError('DEMO_CUSTOMER_PERSONA_REPOSITORY_REQUIRED');
  validatePersona(defaultPersona);
  if (defaultTenantId !== null) validateTenantId(defaultTenantId);

  async function requireSelection(tenantId, persona) {
    validateTenantId(tenantId);
    validatePersona(persona);
    const lookupPersona = persona === DUAL_ROLE_PERSONA ? TENANT_ROLE.TENANT_ADMIN : persona;
    const selection = await personaRepository.findCustomer({ tenantId, persona: lookupPersona });
    if (!selection) throw new TypeError('DEMO_CUSTOMER_CONTEXT_NOT_AVAILABLE');
    return persona === DUAL_ROLE_PERSONA ? dualRoleSelection(selection) : selection;
  }

  async function defaultSelection() {
    if (defaultPersona === DUAL_ROLE_PERSONA) {
      if (defaultTenantId !== null) return requireSelection(defaultTenantId, DUAL_ROLE_PERSONA);
      const selection = await personaRepository.findDefaultCustomer({ persona: TENANT_ROLE.TENANT_ADMIN });
      if (!selection) throw new TypeError('DEMO_CUSTOMER_CONTEXT_NOT_AVAILABLE');
      return dualRoleSelection(selection);
    }
    const selection = defaultTenantId === null
      ? await personaRepository.findDefaultCustomer({ persona: defaultPersona })
      : await personaRepository.findCustomer({ tenantId: defaultTenantId, persona: defaultPersona });
    if (!selection) throw new TypeError('DEMO_CUSTOMER_CONTEXT_NOT_AVAILABLE');
    return selection;
  }

  async function issue(selection, correlationId) {
    const result = await sessionService.issue(trustedIdentity(selection), { correlationId });
    return Object.freeze({ ...result, selection });
  }

  return Object.freeze({
    clearCookie() {
      return sessionService.clearCookie();
    },

    async tenants() {
      return personaRepository.listTenants();
    },

    async establish(request, { correlationId } = {}) {
      const principal = await sessionService.resolvePrincipal(request);
      if (!principal) {
        if (hasSessionCookie(request?.headers)) {
          throw new TypeError('DEMO_CUSTOMER_SESSION_INVALID');
        }
        return issue(await defaultSelection(), correlationId);
      }
      const storedSelection = await personaRepository.findCustomerForPrincipal({
        tenantId: principal.tenantId,
        userId: principal.userId,
      });
      const selection = storedSelection && hasDualRole(principal)
        ? dualRoleSelection(storedSelection)
        : storedSelection;
      if (!selection || !selectionMatchesPrincipal(selection, principal)) {
        throw new TypeError('DEMO_CUSTOMER_SESSION_AUTHORITY_INVALID');
      }
      return Object.freeze({
        principal,
        csrfToken: sessionService.csrfTokenForPrincipal(principal),
        setCookie: null,
        selection,
      });
    },

    async switch(principal, { tenantId, persona, correlationId } = {}) {
      const selection = await requireSelection(tenantId, persona);
      const next = await issue(selection, correlationId);
      try {
        const revoked = await sessionService.revoke(principal, { correlationId });
        if (revoked !== true) throw new TypeError('DEMO_CUSTOMER_SESSION_ROTATION_REJECTED');
      } catch (error) {
        await sessionService.revoke(next.principal, { correlationId }).catch(() => false);
        throw error;
      }
      return next;
    },
  });
}
