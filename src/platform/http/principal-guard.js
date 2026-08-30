import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION } from '../audit/event.js';
import { normalizePlatformPrincipal } from '../identity/principal.js';
import { PlatformHttpError } from './errors.js';

function authenticationFailureReason(headers) {
  const raw = headers?.cookie;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 8_192) {
    return 'platform_session_missing';
  }
  const names = raw.split(';').map((part) => part.split('=', 1)[0].trim());
  if (names.includes('cm_platform_session')) return 'platform_session_invalid';
  if (names.includes('cm_session')) return 'customer_session_rejected';
  return 'platform_session_missing';
}

export function createPlatformPrincipalGuard({
  platformSessionService,
  platformAuditService,
} = {}) {
  if (
    !platformSessionService
    || typeof platformSessionService.resolvePrincipal !== 'function'
    || typeof platformSessionService.verifyCsrf !== 'function'
  ) {
    throw new TypeError('PLATFORM_SESSION_SERVICE_REQUIRED');
  }

  if (
    !platformAuditService
    || typeof platformAuditService.createUnmappedAuthenticationFailure !== 'function'
    || typeof platformAuditService.createDeniedEvent !== 'function'
    || typeof platformAuditService.record !== 'function'
  ) {
    throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');
  }

  function requireCorrelationId(value) {
    if (!isInternalUuid(value)) throw new TypeError('PLATFORM_CORRELATION_ID_REQUIRED');
    return value;
  }

  async function recordUnmappedAuthenticationFailure(request, correlationId, reasonCode) {
    await platformAuditService.record(platformAuditService.createUnmappedAuthenticationFailure({
      correlationId: requireCorrelationId(correlationId),
      reasonCode,
    }));
  }

  async function recordActorDenial(principal, correlationId, reasonCode) {
    await platformAuditService.record(platformAuditService.createDeniedEvent({
      principal,
      action: PLATFORM_AUDIT_ACTION.AUTHORIZATION_DENIED,
      targetType: 'platform_request',
      targetId: reasonCode === 'csrf_invalid' ? 'csrf' : 'origin',
      targetTenantId: null,
      metadata: { reasonCode },
      correlationId: requireCorrelationId(correlationId),
    }));
  }

  async function resolvedPrincipal(request) {
    const resolved = await platformSessionService.resolvePrincipal(request);
    if (resolved === null || resolved === undefined) return null;
    try {
      return normalizePlatformPrincipal(resolved);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return null;
    }
  }

  return Object.freeze({
    async require(request, { csrf = false, correlationId } = {}) {
      const principal = await resolvedPrincipal(request);
      if (principal === null) {
        await recordUnmappedAuthenticationFailure(
          request,
          correlationId,
          authenticationFailureReason(request.headers),
        );
        throw new PlatformHttpError(401, 'PLATFORM_UNAUTHENTICATED', {
          securityCategory: 'authentication',
        });
      }
      if (csrf) {
        const verified = await platformSessionService.verifyCsrf(request, principal);
        if (verified !== true) {
          await recordActorDenial(principal, correlationId, 'csrf_invalid');
          throw new PlatformHttpError(403, 'PLATFORM_CSRF_INVALID', {
            securityCategory: 'authorization',
          });
        }
      }
      return principal;
    },
    async recordOriginDenial(request, { correlationId } = {}) {
      const raw = request.headers?.cookie;
      if (
        typeof raw !== 'string'
        || raw.length > 8_192
        || !raw.split(';').some((part) => part.split('=', 1)[0].trim() === 'cm_platform_session')
      ) return;
      const principal = await resolvedPrincipal(request);
      if (principal !== null) {
        await recordActorDenial(principal, correlationId, 'origin_invalid');
      }
    },
  });
}
