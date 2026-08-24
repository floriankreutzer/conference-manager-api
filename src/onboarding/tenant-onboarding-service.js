import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { ENTRA_IDENTITY_PROVIDER } from '../identity/entra-client.js';
import {
  TENANT_CLAIM_TOKEN_PATTERN,
  serializeClearedTenantClaimCookie,
  serializeTenantClaimCookie,
} from './claim-cookie.js';
import {
  OnboardingConflictError,
  OnboardingDeniedError,
  OnboardingInputError,
} from './errors.js';

const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_INVITATION_TTL_SECONDS = 86_400;
const DEFAULT_CLAIM_TTL_SECONDS = 600;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeSecret(value) {
  const secret = Buffer.from(value || '', 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) {
    throw new TypeError('ONBOARDING_TRANSACTION_SECRET_INVALID');
  }
  return secret;
}

function claimCsrf(secret, claimToken) {
  return createHmac('sha256', secret)
    .update(`claim-csrf:${claimToken}`, 'utf8')
    .digest('base64url');
}

function safeTokenEqual(left, right) {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || !TENANT_CLAIM_TOKEN_PATTERN.test(left)
    || !TENANT_CLAIM_TOKEN_PATTERN.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

function normalizeDisplayName(value) {
  if (typeof value !== 'string') throw new OnboardingInputError();
  const normalized = value.trim();
  if (
    normalized.length < 1
    || normalized.length > 160
    || normalized !== value
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new OnboardingInputError();
  }
  return normalized;
}

function requireToken(value, pattern = INVITATION_TOKEN_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new OnboardingDeniedError();
  return value;
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new OnboardingInputError('ONBOARDING_CORRELATION_INVALID');
  return value;
}

function requireClock(clock) {
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new OnboardingInputError('ONBOARDING_CLOCK_INVALID');
  }
  return nowMs;
}

function normalizeExternalIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OnboardingDeniedError();
  if (value.provider !== ENTRA_IDENTITY_PROVIDER) throw new OnboardingDeniedError();
  if (!PROVIDER_REFERENCE_PATTERN.test(value.tenantReference || '')) throw new OnboardingDeniedError();
  if (!PROVIDER_REFERENCE_PATTERN.test(value.userReference || '')) throw new OnboardingDeniedError();
  const displayName = typeof value.displayName === 'string' ? value.displayName : null;
  if (displayName !== null && (displayName.length < 1 || displayName.length > 200)) {
    throw new OnboardingDeniedError();
  }
  return Object.freeze({
    provider: value.provider,
    tenantReference: value.tenantReference,
    userReference: value.userReference,
    displayName,
  });
}

export function createTenantOnboardingService({
  repository,
  auditService,
  authorizeOperator = async () => false,
  transactionSecret,
  publicOrigin,
  invitationTtlSeconds = DEFAULT_INVITATION_TTL_SECONDS,
  claimTtlSeconds = DEFAULT_CLAIM_TTL_SECONDS,
  clock = () => Date.now(),
  randomToken = () => randomBytes(32).toString('base64url'),
  randomId = () => randomUUID(),
} = {}) {
  const requiredMethods = [
    'createTenantInvitation',
    'findOpenInvitationByTokenHash',
    'prepareClaim',
    'findPendingClaim',
    'confirmClaim',
    'findActiveBindingByTenantId',
    'unbindActive',
  ];
  if (!repository || requiredMethods.some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('TENANT_ONBOARDING_REPOSITORY_REQUIRED');
  }
  if (!auditService || typeof auditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof authorizeOperator !== 'function') throw new TypeError('OPERATOR_AUTHORIZATION_REQUIRED');
  if (typeof publicOrigin !== 'string') throw new TypeError('PUBLIC_ORIGIN_REQUIRED');
  if (!Number.isSafeInteger(invitationTtlSeconds) || invitationTtlSeconds < 900 || invitationTtlSeconds > 604_800) {
    throw new TypeError('ONBOARDING_INVITATION_TTL_INVALID');
  }
  if (!Number.isSafeInteger(claimTtlSeconds) || claimTtlSeconds < 120 || claimTtlSeconds > 900) {
    throw new TypeError('ONBOARDING_CLAIM_TTL_INVALID');
  }
  const secureCookie = new URL(publicOrigin).protocol === 'https:';
  const secret = normalizeSecret(transactionSecret);

  return Object.freeze({
    async createTenantInvitation({ operatorContext, displayName, correlationId }) {
      const normalizedDisplayName = normalizeDisplayName(displayName);
      requireCorrelationId(correlationId);
      const tenantId = randomId();
      const invitationId = randomId();
      if (!isInternalUuid(tenantId) || !isInternalUuid(invitationId)) {
        throw new OnboardingInputError('ONBOARDING_IDENTIFIER_INVALID');
      }
      if (await authorizeOperator(operatorContext, {
        operation: 'create_tenant_invitation',
        tenantId,
      }) !== true) {
        throw new OnboardingDeniedError('OPERATOR_NOT_AUTHORIZED');
      }
      const invitationToken = requireToken(randomToken());
      const nowMs = requireClock(clock);
      const createdAt = new Date(nowMs);
      const expiresAt = new Date(nowMs + (invitationTtlSeconds * 1000));
      const auditEvent = auditService.createActorEvent({
        tenantId,
        actorUserId: null,
        correlationId,
        action: AUDIT_ACTION.TENANT_ONBOARDING_INVITED,
        targetType: 'tenant',
        targetId: tenantId,
        previousState: null,
        newState: { status: 'pending' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { actorType: 'platform_operator' },
        retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        occurredAt: createdAt.toISOString(),
      });
      const created = await repository.createTenantInvitation({
        tenantId,
        displayName: normalizedDisplayName,
        invitationId,
        tokenHash: sha256Hex(invitationToken),
        createdAt,
        expiresAt,
        auditEvent,
      });
      if (!created) throw new OnboardingConflictError();
      return Object.freeze({ tenantId, invitationToken, expiresAt: expiresAt.toISOString() });
    },

    async beginInvitation({ invitationToken }) {
      const token = requireToken(invitationToken);
      const nowMs = requireClock(clock);
      const invitation = await repository.findOpenInvitationByTokenHash({
        tokenHash: sha256Hex(token),
        now: new Date(nowMs),
      });
      if (!invitation) throw new OnboardingDeniedError();
      return Object.freeze({ invitationId: invitation.id });
    },

    async prepareClaim({ invitationId, externalIdentity, correlationId }) {
      if (!isInternalUuid(invitationId)) throw new OnboardingDeniedError();
      requireCorrelationId(correlationId);
      const identity = normalizeExternalIdentity(externalIdentity);
      const claimToken = requireToken(randomToken(), TENANT_CLAIM_TOKEN_PATTERN);
      const nowMs = requireClock(clock);
      const createdAt = new Date(nowMs);
      const expiresAt = new Date(nowMs + (claimTtlSeconds * 1000));
      const prepared = await repository.prepareClaim({
        tokenHash: sha256Hex(claimToken),
        invitationId,
        provider: identity.provider,
        providerTenantReference: identity.tenantReference,
        providerUserReference: identity.userReference,
        displayName: identity.displayName,
        createdAt,
        expiresAt,
      });
      if (!prepared) throw new OnboardingDeniedError();
      return Object.freeze({
        status: 'claim_confirmation_required',
        setCookie: serializeTenantClaimCookie(claimToken, {
          secure: secureCookie,
          maxAgeSeconds: claimTtlSeconds,
        }),
      });
    },

    async claimStatus({ claimToken }) {
      const token = requireToken(claimToken, TENANT_CLAIM_TOKEN_PATTERN);
      const nowMs = requireClock(clock);
      const claim = await repository.findPendingClaim({
        tokenHash: sha256Hex(token),
        now: new Date(nowMs),
      });
      if (!claim) throw new OnboardingDeniedError();
      return Object.freeze({
        tenant: Object.freeze({ displayName: claim.tenantDisplayName }),
        expiresAt: claim.expiresAt.toISOString(),
        csrfToken: claimCsrf(secret, token),
      });
    },

    async confirmClaim({ claimToken, csrfToken, correlationId }) {
      const token = requireToken(claimToken, TENANT_CLAIM_TOKEN_PATTERN);
      requireCorrelationId(correlationId);
      if (!safeTokenEqual(csrfToken, claimCsrf(secret, token))) {
        throw new OnboardingDeniedError('ONBOARDING_CSRF_INVALID');
      }
      const nowMs = requireClock(clock);
      const confirmedAt = new Date(nowMs);
      const preview = await repository.findPendingClaim({
        tokenHash: sha256Hex(token),
        now: confirmedAt,
      });
      if (!preview) throw new OnboardingDeniedError();
      const bindingId = randomId();
      if (!isInternalUuid(bindingId)) throw new OnboardingInputError('ONBOARDING_IDENTIFIER_INVALID');
      const auditEvent = auditService.createActorEvent({
        tenantId: preview.tenantId,
        actorUserId: null,
        correlationId,
        action: AUDIT_ACTION.TENANT_IDENTITY_CLAIMED,
        targetType: 'tenant_identity',
        targetId: preview.tenantId,
        previousState: null,
        newState: { provider: preview.provider, status: 'active' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { actorType: 'external_customer_admin' },
        retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
        occurredAt: confirmedAt.toISOString(),
      });
      const claimed = await repository.confirmClaim({
        tokenHash: sha256Hex(token),
        bindingId,
        confirmedAt,
        auditEvent,
      });
      if (claimed?.conflict) throw new OnboardingConflictError();
      if (!claimed) throw new OnboardingDeniedError();
      return Object.freeze({
        status: 'claimed',
        tenantId: claimed.tenantId,
        tenantStatus: claimed.tenantStatus,
      });
    },

    async unbindTenantIdentity({ operatorContext, tenantId, correlationId, reason }) {
      if (!isInternalUuid(tenantId)) throw new OnboardingInputError();
      requireCorrelationId(correlationId);
      if (typeof reason !== 'string' || reason.trim() !== reason || reason.length < 1 || reason.length > 500) {
        throw new OnboardingInputError();
      }
      if (await authorizeOperator(operatorContext, { operation: 'unbind_tenant_identity', tenantId }) !== true) {
        throw new OnboardingDeniedError('OPERATOR_NOT_AUTHORIZED');
      }
      const binding = await repository.findActiveBindingByTenantId(tenantId, ENTRA_IDENTITY_PROVIDER);
      if (!binding) throw new OnboardingConflictError();
      const changedAtMs = requireClock(clock);
      const changedAt = new Date(changedAtMs);
      const auditEvent = auditService.createActorEvent({
        tenantId,
        actorUserId: null,
        correlationId,
        action: AUDIT_ACTION.TENANT_IDENTITY_UNBOUND,
        targetType: 'tenant_identity',
        targetId: tenantId,
        previousState: { provider: binding.provider, status: 'active' },
        newState: { provider: binding.provider, status: 'unbound' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { actorType: 'platform_operator', reasonProvided: true },
        retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
        occurredAt: changedAt.toISOString(),
      });
      const changed = await repository.unbindActive({
        tenantId,
        provider: binding.provider,
        changedAt,
        auditEvent,
      });
      if (!changed) throw new OnboardingConflictError();
      return changed;
    },

    clearClaimCookie() {
      return serializeClearedTenantClaimCookie({ secure: secureCookie });
    },
  });
}
