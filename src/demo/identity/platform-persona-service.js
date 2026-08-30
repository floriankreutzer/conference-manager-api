import { permissionsForPlatformRoles } from '../../platform/identity/policy.js';
import { DEMO_FIXTURE } from '../fixture.js';

const PERSONA_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const ALLOWED_PERSONAS = new Set(DEMO_FIXTURE.platform.personas.map(({ persona }) => persona));

function sameValues(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validatePersona(name) {
  if (typeof name !== 'string' || !PERSONA_PATTERN.test(name)) {
    throw new TypeError('DEMO_PLATFORM_PERSONA_INVALID');
  }
  if (!ALLOWED_PERSONAS.has(name)) throw new TypeError('DEMO_PLATFORM_PERSONA_NOT_AVAILABLE');
}

function trustedIdentity(persona, now) {
  const roles = Object.freeze([...persona.roles].sort());
  return Object.freeze({
    operatorId: persona.operatorId,
    providerIdentity: persona.providerIdentity,
    roles,
    permissions: permissionsForPlatformRoles(roles),
    securityVersion: persona.securityVersion,
    targetScope: persona.targetScope,
    assurance: Object.freeze({
      level: persona.assurance.level,
      authenticationContext: persona.assurance.authenticationContext,
      authenticatedAt: new Date(now).toISOString(),
    }),
  });
}

function personaMatchesPrincipal(persona, principal) {
  const roles = [...persona.roles].sort();
  const permissions = permissionsForPlatformRoles(roles);
  return persona.operatorId === principal.operatorId
    && persona.securityVersion === principal.securityVersion
    && sameValues(roles, principal.roles)
    && sameValues(permissions, principal.permissions)
    && persona.targetScope.mode === principal.targetScope.mode
    && persona.targetScope.securityVersion === principal.targetScope.securityVersion
    && persona.providerIdentity.provider === principal.providerIdentity.provider
    && persona.providerIdentity.tenantReference === principal.providerIdentity.tenantReference
    && persona.providerIdentity.subjectReference === principal.providerIdentity.subjectReference
    && persona.assurance.level === principal.assurance.level
    && persona.assurance.authenticationContext === principal.assurance.authenticationContext;
}

export function createDemoPlatformPersonaService({
  sessionService,
  personaRepository,
  defaultPersona = 'support_reader',
  clock = () => Date.now(),
} = {}) {
  if (
    !sessionService
    || typeof sessionService.issue !== 'function'
    || typeof sessionService.resolvePrincipal !== 'function'
    || typeof sessionService.revoke !== 'function'
    || typeof sessionService.csrfTokenForPrincipal !== 'function'
  ) throw new TypeError('DEMO_PLATFORM_SESSION_SERVICE_REQUIRED');
  if (
    !personaRepository
    || typeof personaRepository.findPlatform !== 'function'
    || typeof personaRepository.findPlatformForPrincipal !== 'function'
  ) throw new TypeError('DEMO_PLATFORM_PERSONA_REPOSITORY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('DEMO_PLATFORM_CLOCK_REQUIRED');
  validatePersona(defaultPersona);

  async function requirePersona(name) {
    validatePersona(name);
    const persona = await personaRepository.findPlatform({ persona: name });
    if (!persona) throw new TypeError('DEMO_PLATFORM_PERSONA_NOT_AVAILABLE');
    return persona;
  }

  async function issue(persona, correlationId) {
    const result = await sessionService.issue(trustedIdentity(persona, clock()), { correlationId });
    return Object.freeze({ ...result, persona });
  }

  return Object.freeze({
    async establish(request, { correlationId } = {}) {
      const principal = await sessionService.resolvePrincipal(request);
      if (!principal) return issue(await requirePersona(defaultPersona), correlationId);
      const persona = await personaRepository.findPlatformForPrincipal({
        operatorId: principal.operatorId,
      });
      if (!persona || !personaMatchesPrincipal(persona, principal)) {
        throw new TypeError('DEMO_PLATFORM_SESSION_AUTHORITY_INVALID');
      }
      return Object.freeze({
        principal,
        csrfToken: sessionService.csrfTokenForPrincipal(principal),
        setCookie: null,
        persona,
      });
    },

    async switch(principal, { persona: personaName, correlationId } = {}) {
      const persona = await requirePersona(personaName);
      const next = await issue(persona, correlationId);
      try {
        const revoked = await sessionService.revoke(principal, { correlationId });
        if (revoked !== true) throw new TypeError('DEMO_PLATFORM_SESSION_ROTATION_REJECTED');
      } catch (error) {
        await sessionService.revoke(next.principal, { correlationId }).catch(() => false);
        throw error;
      }
      return next;
    },
  });
}
