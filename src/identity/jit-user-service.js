import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import {
  TENANT_ROLE,
  tenantAuthorizationSnapshot,
} from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeAttributionDisplayName } from '../domain/request-attribution.js';
import { normalizeTrustedIdentity } from './principal.js';

const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JIT_FALLBACK_DISPLAY_NAME = 'Provisioned user';

function normalizedDisplayName(value) {
  if (value === null || value === undefined) return null;
  try {
    return normalizeAttributionDisplayName(value);
  } catch {
    return undefined;
  }
}

function normalizedExternalIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.provider !== 'string' || !PROVIDER_PATTERN.test(value.provider)) return null;
  if (typeof value.tenantReference !== 'string' || !REFERENCE_PATTERN.test(value.tenantReference)) return null;
  if (typeof value.userReference !== 'string' || !REFERENCE_PATTERN.test(value.userReference)) return null;
  const displayName = normalizedDisplayName(value.displayName);
  if (displayName === undefined) return null;
  return Object.freeze({
    provider: value.provider,
    tenantReference: value.tenantReference,
    userReference: value.userReference,
    displayName,
  });
}

export function createJitUserService({
  bindingRepository,
  userRepository,
  auditService,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
} = {}) {
  if (!bindingRepository || typeof bindingRepository.findActiveBindingByProvider !== 'function') {
    throw new TypeError('TENANT_IDENTITY_BINDING_REPOSITORY_REQUIRED');
  }
  if (!userRepository || typeof userRepository.resolveOrProvision !== 'function') {
    throw new TypeError('JIT_USER_REPOSITORY_REQUIRED');
  }
  if (!auditService || typeof auditService.createActorEvent !== 'function') {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('JIT_RUNTIME_DEPENDENCY_INVALID');
  }

  return Object.freeze({
    async resolve(externalIdentity, { correlationId } = {}) {
      const external = normalizedExternalIdentity(externalIdentity);
      if (!external || !isInternalUuid(correlationId)) {
        return Object.freeze({ status: 'authentication_denied' });
      }

      const tenantBinding = await bindingRepository.findActiveBindingByProvider(
        external.provider,
        external.tenantReference,
      );
      if (!tenantBinding) return Object.freeze({ status: 'onboarding_required' });

      const nowMs = clock();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('JIT_CLOCK_INVALID');
      const changedAt = new Date(nowMs);
      const occurredAt = changedAt.toISOString();
      const newUserId = idFactory();
      if (!isInternalUuid(newUserId)) throw new TypeError('JIT_USER_ID_INVALID');
      const bootstrapTenantAdmin = tenantBinding.claimantProviderUserReference === external.userReference;

      const provisionAuditEvent = auditService.createActorEvent({
        tenantId: tenantBinding.tenantId,
        actorUserId: newUserId,
        correlationId,
        action: AUDIT_ACTION.TENANT_USER_PROVISIONED,
        targetType: 'user',
        targetId: newUserId,
        previousState: null,
        newState: { active: true, role: TENANT_ROLE.EMPLOYEE },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { source: 'jit' },
        retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
        occurredAt,
      });
      const bootstrapAuditEvent = bootstrapTenantAdmin
        ? auditService.createActorEvent({
          tenantId: tenantBinding.tenantId,
          actorUserId: newUserId,
          correlationId,
          action: AUDIT_ACTION.TENANT_USER_PERMISSIONS_CHANGED,
          targetType: 'user',
          targetId: newUserId,
          previousState: { conferenceManager: false, tenantAdmin: false },
          newState: { conferenceManager: false, tenantAdmin: true },
          outcome: AUDIT_OUTCOME.SUCCESS,
          metadata: { operation: 'bootstrap_tenant_admin', source: 'tenant_claimant' },
          retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
          occurredAt,
        })
        : null;

      const result = await userRepository.resolveOrProvision({
        tenantId: tenantBinding.tenantId,
        provider: external.provider,
        providerTenantReference: external.tenantReference,
        providerUserReference: external.userReference,
        displayName: external.displayName,
        fallbackDisplayName: JIT_FALLBACK_DISPLAY_NAME,
        newUserId,
        changedAt,
        provisionAuditEvent,
        bootstrapTenantAdmin,
        bootstrapAuditEvent,
        profileAuditEventFor(userId) {
          return auditService.createActorEvent({
            tenantId: tenantBinding.tenantId,
            actorUserId: userId,
            correlationId,
            action: AUDIT_ACTION.TENANT_USER_PROFILE_UPDATED,
            targetType: 'user',
            targetId: userId,
            previousState: null,
            newState: null,
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { displayNameChanged: true, source: 'jit' },
            retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
            occurredAt,
          });
        },
      });

      if (result?.status === 'tenant_unavailable' || result?.status === 'user_disabled') {
        return Object.freeze({ status: 'authentication_denied' });
      }
      if (result?.status === 'binding_unavailable') {
        return Object.freeze({ status: 'onboarding_required' });
      }
      if (result?.status !== 'resolved' || !result.identity) {
        throw new TypeError('JIT_USER_RESOLUTION_INVALID');
      }

      const snapshot = tenantAuthorizationSnapshot([
        TENANT_ROLE.EMPLOYEE,
        ...(result.identity.elevatedRoles || []),
      ]);
      return Object.freeze({
        status: 'authenticated',
        trustedIdentity: normalizeTrustedIdentity({
          userId: result.identity.userId,
          tenantId: result.identity.tenantId,
          providerIdentity: {
            provider: external.provider,
            reference: `${external.tenantReference}:${external.userReference}`,
          },
          roles: snapshot.roles,
          permissions: snapshot.permissions,
          securityVersion: result.identity.securityVersion,
        }),
      });
    },
  });
}
