import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { DEMO_FIXTURE } from '../fixture.js';

const PERSONA_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALLOWED_PERSONAS = new Set(DEMO_FIXTURE.customerPersonas.map(({ persona }) => persona));

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
    const selection = await personaRepository.findCustomer({ tenantId, persona });
    if (!selection) throw new TypeError('DEMO_CUSTOMER_CONTEXT_NOT_AVAILABLE');
    return selection;
  }

  async function defaultSelection() {
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
    async tenants() {
      return personaRepository.listTenants();
    },

    async establish(request, { correlationId } = {}) {
      const principal = await sessionService.resolvePrincipal(request);
      if (!principal) return issue(await defaultSelection(), correlationId);
      const selection = await personaRepository.findCustomerForPrincipal({
        tenantId: principal.tenantId,
        userId: principal.userId,
      });
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
