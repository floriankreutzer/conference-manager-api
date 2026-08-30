import { createHash, randomBytes } from 'node:crypto';

export const TENANT_INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEFAULT_TENANT_INVITATION_TTL_SECONDS = 86_400;

export function normalizeTenantInvitationDisplayName(value) {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length < 1
    || value.length > 160
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw new TypeError('TENANT_INVITATION_DISPLAY_NAME_INVALID');
  return value;
}

export function requireTenantInvitationToken(value) {
  if (typeof value !== 'string' || !TENANT_INVITATION_TOKEN_PATTERN.test(value)) {
    throw new TypeError('TENANT_INVITATION_TOKEN_INVALID');
  }
  return value;
}

export function hashTenantInvitationToken(value) {
  return createHash('sha256').update(requireTenantInvitationToken(value), 'utf8').digest('hex');
}

export function createTenantInvitationSecretFactory({
  invitationTtlSeconds = DEFAULT_TENANT_INVITATION_TTL_SECONDS,
  randomToken = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (
    !Number.isSafeInteger(invitationTtlSeconds)
    || invitationTtlSeconds < 900
    || invitationTtlSeconds > 604_800
  ) throw new TypeError('TENANT_INVITATION_TTL_INVALID');
  if (typeof randomToken !== 'function') throw new TypeError('TENANT_INVITATION_TOKEN_FACTORY_INVALID');
  return Object.freeze({
    async issue({ issuedAt } = {}) {
      const issuedAtMs = Date.parse(issuedAt);
      if (!Number.isFinite(issuedAtMs) || new Date(issuedAtMs).toISOString() !== issuedAt) {
        throw new TypeError('TENANT_INVITATION_ISSUED_AT_INVALID');
      }
      const token = requireTenantInvitationToken(randomToken());
      return Object.freeze({
        token,
        tokenHash: hashTenantInvitationToken(token),
        expiresAt: new Date(issuedAtMs + invitationTtlSeconds * 1000).toISOString(),
      });
    },
  });
}

