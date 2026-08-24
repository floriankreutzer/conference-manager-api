import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { normalizePrincipal, normalizeTrustedIdentity } from './principal.js';
import {
  SESSION_TOKEN_PATTERN,
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from './session-cookie.js';

const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

export class SessionServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SessionServiceError';
    this.code = code;
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function csrfToken(secret, sessionId) {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`, 'utf8').digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left, 'ascii');
  const rightBuffer = Buffer.from(right, 'ascii');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sessionRecord(identity, { id, token, issuedAt, expiresAt }) {
  return Object.freeze({
    id,
    tenantId: identity.tenantId,
    userId: identity.userId,
    tokenHash: tokenHash(token),
    providerIdentity: identity.providerIdentity,
    roles: identity.roles,
    permissions: identity.permissions,
    issuedAt,
    expiresAt,
  });
}

function principalFromSession(session) {
  return normalizePrincipal({
    userId: session.userId,
    tenantId: session.tenantId,
    providerIdentity: session.providerIdentity,
    roles: session.roles,
    permissions: session.permissions,
    session: {
      id: session.id,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      securityVersion: session.securityVersion,
    },
  });
}

export function createSessionService({
  repository,
  publicOrigin,
  csrfSecret,
  sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  clock = () => Date.now(),
  tokenFactory = () => randomBytes(32).toString('base64url'),
  idFactory = () => randomUUID(),
} = {}) {
  if (!repository || typeof repository.issue !== 'function' || typeof repository.resolveByTokenHash !== 'function') {
    throw new TypeError('SESSION_REPOSITORY_REQUIRED');
  }
  if (typeof publicOrigin !== 'string') throw new TypeError('PUBLIC_ORIGIN_REQUIRED');
  const secure = new URL(publicOrigin).protocol === 'https:';
  const secret = csrfSecret === undefined || csrfSecret === null
    ? randomBytes(32)
    : Buffer.from(csrfSecret, 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) throw new TypeError('CSRF_SECRET_INVALID');
  if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > 86_400) {
    throw new TypeError('SESSION_TTL_INVALID');
  }

  function generateSession(identity) {
    const token = tokenFactory();
    const id = idFactory();
    if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) {
      throw new TypeError('SESSION_TOKEN_FACTORY_INVALID');
    }
    const issuedMs = clock();
    if (!Number.isSafeInteger(issuedMs) || issuedMs < 0) throw new TypeError('SESSION_CLOCK_INVALID');
    const issuedAt = new Date(issuedMs).toISOString();
    const expiresAt = new Date(issuedMs + (sessionTtlSeconds * 1000)).toISOString();
    return Object.freeze({
      token,
      record: sessionRecord(identity, { id, token, issuedAt, expiresAt }),
    });
  }

  function resultFor(token, stored) {
    const principal = principalFromSession(stored);
    return Object.freeze({
      principal,
      csrfToken: csrfToken(secret, principal.session.id),
      setCookie: serializeSessionCookie(token, {
        secure,
        maxAgeSeconds: sessionTtlSeconds,
      }),
    });
  }

  return Object.freeze({
    async issue(trustedIdentity) {
      const identity = normalizeTrustedIdentity(trustedIdentity);
      const generated = generateSession(identity);
      const stored = await repository.issue(generated.record);
      if (!stored) throw new SessionServiceError('IDENTITY_NOT_PROVISIONED');
      return resultFor(generated.token, stored);
    },

    async resolvePrincipal(request) {
      const token = readSessionToken(request?.headers);
      if (!token) return null;
      const now = new Date(clock());
      const stored = await repository.resolveByTokenHash(tokenHash(token), now);
      return stored ? principalFromSession(stored) : null;
    },

    csrfTokenForPrincipal(principalValue) {
      const principal = normalizePrincipal(principalValue);
      return csrfToken(secret, principal.session.id);
    },

    async verifyCsrf(request, principalValue) {
      const principal = normalizePrincipal(principalValue);
      const presented = request?.headers?.['x-csrf-token'];
      if (typeof presented !== 'string' || !CSRF_TOKEN_PATTERN.test(presented)) return false;
      return safeEqual(presented, csrfToken(secret, principal.session.id));
    },

    async revoke(principalValue) {
      const principal = normalizePrincipal(principalValue);
      return repository.revoke({
        sessionId: principal.session.id,
        tenantId: principal.tenantId,
        userId: principal.userId,
        revokedAt: new Date(clock()),
      });
    },

    async rotate(principalValue, trustedIdentity) {
      const principal = normalizePrincipal(principalValue);
      const identity = normalizeTrustedIdentity(trustedIdentity);
      if (identity.userId !== principal.userId || identity.tenantId !== principal.tenantId) {
        throw new SessionServiceError('SESSION_ROTATION_SUBJECT_MISMATCH');
      }
      const generated = generateSession(identity);
      const stored = await repository.rotate({
        currentSessionId: principal.session.id,
        session: generated.record,
        revokedAt: new Date(clock()),
      });
      if (!stored) throw new SessionServiceError('SESSION_ROTATION_REJECTED');
      return resultFor(generated.token, stored);
    },

    clearCookie() {
      return serializeClearedSessionCookie({ secure });
    },
  });
}
