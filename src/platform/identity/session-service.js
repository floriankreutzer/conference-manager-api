import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  PLATFORM_AUDIT_ACTION,
  PLATFORM_AUDIT_OUTCOME,
  PLATFORM_AUDIT_RETENTION,
  normalizePlatformAuditEvent,
} from '../audit/event.js';
import { PlatformSessionError } from './errors.js';
import { normalizePlatformPrincipal, normalizeTrustedPlatformIdentity } from './principal.js';
import {
  PLATFORM_SESSION_TOKEN_PATTERN,
  readPlatformSessionToken,
  serializeClearedPlatformSessionCookie,
  serializePlatformSessionCookie,
} from './session-cookie.js';

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_SESSION_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_STEP_UP_TTL_SECONDS = 5 * 60;
const DEFAULT_AUTHENTICATION_MAX_AGE_SECONDS = 15 * 60;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'ascii');
  const rightBuffer = Buffer.from(right, 'ascii');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenHash(token, securityEpoch) {
  return createHash('sha256')
    .update(`platform-session:v1:${securityEpoch}:${token}`, 'ascii')
    .digest('hex');
}

function csrfToken(secret, principal) {
  return createHmac('sha256', secret)
    .update(`platform-csrf:v1:${principal.session.securityEpoch}:${principal.session.id}`, 'utf8')
    .digest('base64url');
}

function eventForIdentity(identity, {
  action,
  targetType = 'platform_operator',
  targetId = identity.operatorId,
  correlationId,
  occurredAt,
  outcome = PLATFORM_AUDIT_OUTCOME.SUCCESS,
  previousState = null,
  newState = null,
  metadata = {},
} = {}) {
  return normalizePlatformAuditEvent({
    operatorId: identity.operatorId,
    roles: identity.roles,
    permissions: identity.permissions,
    assuranceLevel: identity.assurance.level,
    targetTenantId: null,
    action,
    targetType,
    targetId,
    previousState,
    newState,
    occurredAt,
    correlationId: correlationId || randomUUID(),
    outcome,
    metadata,
    retentionClass: PLATFORM_AUDIT_RETENTION.SECURITY,
  });
}

function principalFromStoredSession(session) {
  return normalizePlatformPrincipal({
    operatorId: session.operatorId,
    providerIdentity: session.providerIdentity,
    roles: session.roles,
    permissions: session.permissions,
    securityVersion: session.securityVersion,
    targetScope: session.targetScope,
    assurance: session.assurance,
    session: {
      id: session.id,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      securityVersion: session.securityVersion,
      securityEpoch: session.securityEpoch,
      stepUpExpiresAt: session.stepUpExpiresAt,
    },
  });
}

export function createPlatformSessionService({
  repository,
  publicOrigin,
  csrfSecret,
  securityEpoch,
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  stepUpTtlSeconds = DEFAULT_STEP_UP_TTL_SECONDS,
  authenticationMaxAgeSeconds = DEFAULT_AUTHENTICATION_MAX_AGE_SECONDS,
  clock = () => Date.now(),
  tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.issue !== 'function'
    || typeof repository.resolveByTokenHash !== 'function'
    || typeof repository.revoke !== 'function'
    || typeof repository.rotate !== 'function'
  ) throw new TypeError('PLATFORM_SESSION_REPOSITORY_REQUIRED');
  if (typeof publicOrigin !== 'string') throw new TypeError('PLATFORM_PUBLIC_ORIGIN_REQUIRED');
  const parsedOrigin = new URL(publicOrigin);
  if (
    parsedOrigin.protocol !== 'https:'
    || parsedOrigin.origin !== publicOrigin
    || parsedOrigin.username !== ''
    || parsedOrigin.password !== ''
    || parsedOrigin.pathname !== '/'
    || parsedOrigin.search !== ''
    || parsedOrigin.hash !== ''
  ) throw new TypeError('PLATFORM_PUBLIC_ORIGIN_INVALID');
  const secure = true;
  const secret = Buffer.from(csrfSecret || '', 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) throw new TypeError('PLATFORM_CSRF_SECRET_INVALID');
  if (!Number.isSafeInteger(securityEpoch) || securityEpoch < 1) {
    throw new TypeError('PLATFORM_SESSION_EPOCH_INVALID');
  }
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > 86_400) {
    throw new TypeError('PLATFORM_SESSION_TTL_INVALID');
  }
  if (!Number.isSafeInteger(stepUpTtlSeconds) || stepUpTtlSeconds < 60 || stepUpTtlSeconds > 300) {
    throw new TypeError('PLATFORM_STEP_UP_TTL_INVALID');
  }
  if (
    !Number.isSafeInteger(authenticationMaxAgeSeconds)
    || authenticationMaxAgeSeconds < 60
    || authenticationMaxAgeSeconds > 1_800
  ) throw new TypeError('PLATFORM_AUTHENTICATION_MAX_AGE_INVALID');

  function freshIdentity(value) {
    const identity = normalizeTrustedPlatformIdentity(value);
    const authenticatedAt = Date.parse(identity.assurance.authenticatedAt);
    const now = clock();
    if (
      !Number.isSafeInteger(now)
      || authenticatedAt > now + 60_000
      || authenticatedAt <= now - (authenticationMaxAgeSeconds * 1000)
    ) throw new PlatformSessionError('PLATFORM_AUTHENTICATION_NOT_FRESH');
    return identity;
  }

  function generatedRecord(identity) {
    const token = tokenFactory();
    const id = idFactory();
    if (!PLATFORM_SESSION_TOKEN_PATTERN.test(token || '')) {
      throw new TypeError('PLATFORM_SESSION_TOKEN_FACTORY_INVALID');
    }
    return Object.freeze({
      token,
      record: Object.freeze({
        id,
        operatorId: identity.operatorId,
        tokenHash: tokenHash(token, securityEpoch),
        providerIdentity: identity.providerIdentity,
        roles: identity.roles,
        permissions: identity.permissions,
        expectedSecurityVersion: identity.securityVersion,
        targetScope: identity.targetScope,
        securityEpoch,
        assurance: identity.assurance,
        sessionTtlSeconds,
        stepUpTtlSeconds,
      }),
    });
  }

  function result(token, stored) {
    const principal = principalFromStoredSession(stored);
    return Object.freeze({
      principal,
      csrfToken: csrfToken(secret, principal),
      setCookie: serializePlatformSessionCookie(token, {
        secure,
        maxAgeSeconds: sessionTtlSeconds,
      }),
    });
  }

  return Object.freeze({
    async issue(identityValue, { correlationId } = {}) {
      const identity = freshIdentity(identityValue);
      const generated = generatedRecord(identity);
      const stored = await repository.issue(generated.record, (issued) => [
        eventForIdentity(identity, {
          action: PLATFORM_AUDIT_ACTION.AUTHENTICATION_SUCCEEDED,
          correlationId,
          occurredAt: issued.issuedAt,
          metadata: { assuranceLevel: identity.assurance.level },
        }),
        eventForIdentity(identity, {
          action: PLATFORM_AUDIT_ACTION.SESSION_ISSUED,
          correlationId,
          occurredAt: issued.issuedAt,
          metadata: {
            assuranceLevel: identity.assurance.level,
            permissionCount: identity.permissions.length,
            roleCount: identity.roles.length,
            securityEpoch,
          },
        }),
      ]);
      if (!stored) throw new PlatformSessionError('PLATFORM_OPERATOR_NOT_PROVISIONED');
      return result(generated.token, stored);
    },

    async resolvePrincipal(request) {
      const token = readPlatformSessionToken(request?.headers);
      if (!token) return null;
      const stored = await repository.resolveByTokenHash(tokenHash(token, securityEpoch), securityEpoch);
      return stored ? principalFromStoredSession(stored) : null;
    },

    csrfTokenForPrincipal(principalValue) {
      return csrfToken(secret, normalizePlatformPrincipal(principalValue));
    },

    async verifyCsrf(request, principalValue) {
      const principal = normalizePlatformPrincipal(principalValue);
      const presented = request?.headers?.['x-csrf-token'];
      if (typeof presented !== 'string' || !CSRF_TOKEN_PATTERN.test(presented)) return false;
      return safeEqual(presented, csrfToken(secret, principal));
    },

    async revoke(principalValue, { correlationId } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      return repository.revoke({
        sessionId: principal.session.id,
        operatorId: principal.operatorId,
        eventFactory: (revokedAt) => eventForIdentity(principal, {
          action: PLATFORM_AUDIT_ACTION.SESSION_REVOKED,
          correlationId,
          occurredAt: revokedAt,
          previousState: { state: 'active' },
          newState: { state: 'revoked' },
        }),
      });
    },

    async rotate(principalValue, identityValue, { correlationId, purpose = 'rotation' } = {}) {
      const principal = normalizePlatformPrincipal(principalValue);
      const identity = freshIdentity(identityValue);
      if (
        identity.operatorId !== principal.operatorId
        || identity.providerIdentity.provider !== principal.providerIdentity.provider
        || identity.providerIdentity.tenantReference !== principal.providerIdentity.tenantReference
        || identity.providerIdentity.subjectReference !== principal.providerIdentity.subjectReference
      ) throw new PlatformSessionError('PLATFORM_SESSION_SUBJECT_MISMATCH');
      if (!['rotation', 'step_up'].includes(purpose)) throw new TypeError('PLATFORM_SESSION_ROTATION_PURPOSE_INVALID');
      if (purpose === 'rotation' && (
        identity.assurance.level !== principal.assurance.level
        || identity.assurance.authenticatedAt !== principal.assurance.authenticatedAt
      )) throw new PlatformSessionError('PLATFORM_ROTATION_CANNOT_CHANGE_ASSURANCE');
      if (purpose === 'step_up' && identity.assurance.level !== 'step_up') {
        throw new PlatformSessionError('PLATFORM_STEP_UP_ASSERTION_REQUIRED');
      }
      const generated = generatedRecord(identity);
      const stored = await repository.rotate({
        currentSessionId: principal.session.id,
        session: generated.record,
        eventFactory: (issued) => eventForIdentity(identity, {
          action: PLATFORM_AUDIT_ACTION.SESSION_ROTATED,
          correlationId,
          occurredAt: issued.issuedAt,
          metadata: {
            assuranceChanged: identity.assurance.level !== principal.assurance.level,
            purpose,
          },
        }),
      });
      if (!stored) throw new PlatformSessionError('PLATFORM_SESSION_ROTATION_REJECTED');
      return result(generated.token, stored);
    },

    clearCookie() {
      return serializeClearedPlatformSessionCookie({ secure });
    },
  });
}
