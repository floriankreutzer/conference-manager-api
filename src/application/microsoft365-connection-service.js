import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AUDIT_ACTION,
  AUDIT_OUTCOME,
  AUDIT_RETENTION_CLASS,
} from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { ENTRA_IDENTITY_PROVIDER } from '../identity/entra-client.js';
import {
  MICROSOFT365_BASE_PERMISSIONS,
  MICROSOFT365_VERIFICATION,
} from '../integrations/microsoft365-client.js';
import {
  Microsoft365ConnectionConflictError,
  Microsoft365ConnectionInputError,
  Microsoft365ConnectionUnavailableError,
} from './microsoft365-connection-errors.js';

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_CONSENT_TTL_SECONDS = 600;
const PLACES_PERMISSIONS = new Set(['granted', 'missing', 'unknown']);
const CALENDAR_PERMISSIONS = new Set(['granted', 'missing', 'unknown', 'unverified']);

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new Microsoft365ConnectionInputError('MICROSOFT365_CORRELATION_INVALID');
}

function requireState(value) {
  if (typeof value !== 'string' || !STATE_PATTERN.test(value)) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_CONSENT_STATE_INVALID');
  }
  return value;
}

function requireProviderTenant(value) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_PROVIDER_TENANT_INVALID');
  }
  return value.toLowerCase();
}

function optionalProviderTenant(value) {
  if (value === null || value === undefined) return null;
  return requireProviderTenant(value);
}

function publicConnection(connection) {
  if (!connection) return Object.freeze({
    status: 'disconnected',
    placesPermission: 'unknown',
    calendarsPermission: 'unknown',
    reason: null,
    lastVerifiedAt: null,
    requiredPermissions: MICROSOFT365_BASE_PERMISSIONS,
  });
  return Object.freeze({
    status: connection.status,
    placesPermission: connection.placesPermission,
    calendarsPermission: connection.calendarsPermission,
    reason: connection.reason,
    lastVerifiedAt: connection.lastVerifiedAt,
    requiredPermissions: MICROSOFT365_BASE_PERMISSIONS,
  });
}

function providerStatus(verification) {
  if (verification.status === MICROSOFT365_VERIFICATION.CONNECTED) return 'connected';
  if (verification.status === MICROSOFT365_VERIFICATION.REVOKED) return 'revoked';
  if (verification.status === MICROSOFT365_VERIFICATION.DEGRADED) return 'degraded';
  throw new Microsoft365ConnectionUnavailableError('MICROSOFT365_VERIFICATION_INVALID');
}

function verificationPermission(value, allowed) {
  if (!allowed.has(value)) throw new Microsoft365ConnectionUnavailableError('MICROSOFT365_VERIFICATION_INVALID');
  return value;
}

function changedAt(clock) {
  const nowMs = clock();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Microsoft365ConnectionInputError('MICROSOFT365_CLOCK_INVALID');
  }
  return new Date(nowMs);
}

export function createMicrosoft365ConnectionService({
  repository,
  bindingRepository,
  authorizationPolicy,
  auditService,
  providerClient,
  consentTtlSeconds = DEFAULT_CONSENT_TTL_SECONDS,
  clock = () => Date.now(),
  idFactory = () => randomUUID(),
  stateFactory = () => randomBytes(32).toString('base64url'),
} = {}) {
  const requiredRepositoryMethods = [
    'findByTenantId',
    'startConsent',
    'consumeConsent',
    'finalizeConsent',
    'disconnect',
  ];
  if (!repository || requiredRepositoryMethods.some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('MICROSOFT365_CONNECTION_REPOSITORY_REQUIRED');
  }
  if (!bindingRepository || typeof bindingRepository.findActiveBindingByTenantId !== 'function') {
    throw new TypeError('TENANT_BINDING_REPOSITORY_REQUIRED');
  }
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !auditService
    || typeof auditService.createEvent !== 'function'
    || typeof auditService.record !== 'function'
    || typeof auditService.recordAuthorizationDenied !== 'function'
  ) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (
    !providerClient
    || typeof providerClient.adminConsentUrl !== 'function'
    || typeof providerClient.verifyBasePermissions !== 'function'
  ) {
    throw new TypeError('MICROSOFT365_PROVIDER_CLIENT_REQUIRED');
  }
  if (!Number.isSafeInteger(consentTtlSeconds) || consentTtlSeconds < 120 || consentTtlSeconds > 900) {
    throw new TypeError('MICROSOFT365_CONSENT_TTL_INVALID');
  }

  async function authorize({ principal, tenantContext, correlationId, operation }) {
    try {
      authorizationPolicy.requireTenantPermission(
        principal,
        tenantContext,
        PERMISSION.TENANT_INTEGRATIONS_MANAGE,
      );
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        await auditService.recordAuthorizationDenied({
          principal,
          tenantContext,
          correlationId,
          targetType: 'integration',
          targetId: 'microsoft365',
          metadata: { operation },
        });
      }
      throw error;
    }
  }

  async function bindingFor(tenantContext) {
    const binding = await bindingRepository.findActiveBindingByTenantId(
      tenantContext.tenantId,
      ENTRA_IDENTITY_PROVIDER,
    );
    if (!binding || typeof binding.providerTenantReference !== 'string') {
      throw new Microsoft365ConnectionConflictError('MICROSOFT365_TENANT_NOT_CLAIMED');
    }
    return Object.freeze({
      ...binding,
      providerTenantReference: requireProviderTenant(binding.providerTenantReference),
    });
  }

  function consentAuditFactory({ principal, tenantContext, correlationId, occurredAt }) {
    return ({ integrationId, previousStatus, nextStatus, providerRebound = false }) => auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
      targetType: 'integration',
      targetId: integrationId,
      previousState: previousStatus ? { provider: 'microsoft365', status: previousStatus } : null,
      newState: { provider: 'microsoft365', status: nextStatus },
      outcome: AUDIT_OUTCOME.SUCCESS,
      metadata: { operation: 'admin_consent_start', providerRebound },
      retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      occurredAt,
    });
  }

  function finalConsentAuditEvents({
    principal,
    tenantContext,
    correlationId,
    integrationId,
    previousStatus,
    finalStatus,
    reason,
    occurredAt,
    approved,
  }) {
    const consentEvent = auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
      targetType: 'integration',
      targetId: integrationId,
      previousState: { provider: 'microsoft365', status: previousStatus },
      newState: { provider: 'microsoft365', status: finalStatus },
      outcome: approved ? AUDIT_OUTCOME.SUCCESS : AUDIT_OUTCOME.FAILURE,
      metadata: {
        operation: 'admin_consent_complete',
        consentApproved: approved,
        ...(reason ? { reasonCode: reason } : {}),
      },
      retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      occurredAt,
    });
    if (!approved || finalStatus !== 'connected') return [consentEvent];
    return [
      consentEvent,
      auditService.createEvent({
        principal,
        tenantContext,
        correlationId,
        action: AUDIT_ACTION.INTEGRATION_CONNECTED,
        targetType: 'integration',
        targetId: integrationId,
        previousState: { provider: 'microsoft365', status: previousStatus },
        newState: { provider: 'microsoft365', status: 'connected' },
        outcome: AUDIT_OUTCOME.SUCCESS,
        metadata: { operation: 'connect' },
        retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        occurredAt,
      }),
    ];
  }

  function consentRejectionAuditFactory({ principal, tenantContext, correlationId, occurredAt }) {
    return ({ integrationId, previousStatus, reasonCode }) => auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
      targetType: 'integration',
      targetId: integrationId ?? 'microsoft365',
      previousState: previousStatus
        ? { provider: 'microsoft365', status: previousStatus }
        : null,
      newState: previousStatus
        ? { provider: 'microsoft365', status: previousStatus }
        : null,
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        operation: 'admin_consent_callback_rejected',
        reasonCode,
      },
      retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
      occurredAt,
    });
  }

  async function recordConsentCallbackRejection({
    principal,
    tenantContext,
    correlationId,
    reasonCode,
  }) {
    requireCorrelationId(correlationId);
    await authorize({ principal, tenantContext, correlationId, operation: 'consent_callback' });
    return auditService.record({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.INTEGRATION_ADMIN_CONSENT_CHANGED,
      targetType: 'integration',
      targetId: 'microsoft365',
      outcome: AUDIT_OUTCOME.FAILURE,
      metadata: {
        operation: 'admin_consent_callback_rejected',
        reasonCode,
      },
      retentionClass: AUDIT_RETENTION_CLASS.SECURITY,
    });
  }

  function verificationAuditEvent({
    principal,
    tenantContext,
    correlationId,
    integrationId,
    previousStatus,
    finalStatus,
    reason,
    occurredAt,
    outcome = null,
  }) {
    return auditService.createEvent({
      principal,
      tenantContext,
      correlationId,
      action: AUDIT_ACTION.INTEGRATION_VERIFIED,
      targetType: 'integration',
      targetId: integrationId,
      previousState: { provider: 'microsoft365', status: previousStatus },
      newState: { provider: 'microsoft365', status: finalStatus },
      outcome: outcome ?? (finalStatus === 'connected' ? AUDIT_OUTCOME.SUCCESS : AUDIT_OUTCOME.FAILURE),
      metadata: {
        operation: 'verify',
        ...(reason ? { reasonCode: reason } : {}),
      },
      retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
      occurredAt,
    });
  }

  async function finalizeVerification({
    tenantContext,
    consumed,
    providerTenantReference,
    verification,
    approved,
    auditEvents,
    bindingUnavailableAuditEvent = null,
  }) {
    const at = changedAt(clock);
    const preserveConnection = !approved
      && ['connected', 'degraded', 'revoked'].includes(consumed.connectionStatus);
    const status = approved
      ? providerStatus(verification)
      : preserveConnection ? consumed.connectionStatus : 'disconnected';
    const reason = approved
      ? (verification.reason ?? null)
      : preserveConnection ? (consumed.connectionReason ?? null) : 'consent_denied';
    const lastVerifiedAt = preserveConnection && consumed.lastVerifiedAt
      ? new Date(consumed.lastVerifiedAt)
      : null;
    if (lastVerifiedAt && Number.isNaN(lastVerifiedAt.getTime())) {
      throw new Microsoft365ConnectionUnavailableError('MICROSOFT365_CONNECTION_STATE_INVALID');
    }
    const result = await repository.finalizeConsent({
      tenantId: tenantContext.tenantId,
      integrationId: consumed.integrationId,
      providerTenantReference,
      connectionVersion: consumed.connectionVersion,
      status,
      placesPermission: approved
        ? verificationPermission(verification.places, PLACES_PERMISSIONS)
        : preserveConnection ? consumed.placesPermission : 'unknown',
      calendarsPermission: approved
        ? verificationPermission(verification.calendars, CALENDAR_PERMISSIONS)
        : preserveConnection ? consumed.calendarsPermission : 'unknown',
      reason,
      lastVerifiedAt: approved ? at : lastVerifiedAt,
      changedAt: at,
      auditEvents: auditEvents({ status, reason, occurredAt: at.toISOString() }),
      bindingUnavailableAuditEvent: bindingUnavailableAuditEvent
        ? bindingUnavailableAuditEvent({ occurredAt: at.toISOString() })
        : null,
    });
    if (result?.status === 'binding_unavailable') {
      throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
    }
    if (result?.status === 'stale') throw new Microsoft365ConnectionConflictError('MICROSOFT365_CONNECTION_STALE');
    if (result?.status !== 'updated' || !result.connection) {
      throw new Microsoft365ConnectionUnavailableError();
    }
    return publicConnection(result.connection);
  }

  return Object.freeze({
    async getConnection({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'read' });
      return publicConnection(await repository.findByTenantId(tenantContext.tenantId));
    },

    async startConnection({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'connect' });
      const binding = await bindingFor(tenantContext);
      const state = requireState(stateFactory());
      const integrationId = idFactory();
      const transactionId = idFactory();
      if (!isInternalUuid(integrationId) || !isInternalUuid(transactionId)) {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_IDENTIFIER_INVALID');
      }
      const authorizationUrl = providerClient.adminConsentUrl({
        tenantReference: binding.providerTenantReference,
        state,
      });
      const at = changedAt(clock);
      const expiresAt = new Date(at.getTime() + consentTtlSeconds * 1000);
      const started = await repository.startConsent({
        tenantId: tenantContext.tenantId,
        actorUserId: principal.userId,
        integrationId,
        transactionId,
        providerTenantReference: binding.providerTenantReference,
        stateHash: sha256Hex(state),
        createdAt: at,
        expiresAt,
        auditEventFor: consentAuditFactory({
          principal,
          tenantContext,
          correlationId,
          occurredAt: at.toISOString(),
        }),
      });
      if (started?.status === 'provider_mismatch') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
      }
      if (started?.status === 'binding_unavailable') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_TENANT_NOT_CLAIMED');
      }
      if (started?.status === 'booking_reconciliation_required') {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_BOOKING_RECONCILIATION_REQUIRED');
      }
      if (started?.status !== 'pending') throw new Microsoft365ConnectionUnavailableError();
      return Object.freeze({ authorizationUrl, expiresAt: expiresAt.toISOString() });
    },

    async completeConsent({
      principal,
      tenantContext,
      correlationId,
      state,
      providerTenantReference = null,
      approved,
    }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'consent_callback' });
      const normalizedState = requireState(state);
      if (typeof approved !== 'boolean') {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_CONSENT_RESULT_INVALID');
      }
      const callbackTenant = optionalProviderTenant(providerTenantReference);
      if (approved && callbackTenant === null) {
        throw new Microsoft365ConnectionInputError('MICROSOFT365_PROVIDER_TENANT_INVALID');
      }

      const callbackAt = changedAt(clock);
      const consumed = await repository.consumeConsent({
        tenantId: tenantContext.tenantId,
        actorUserId: principal.userId,
        stateHash: sha256Hex(normalizedState),
        callbackProviderTenantReference: callbackTenant,
        now: callbackAt,
        rejectionAuditEventFor: consentRejectionAuditFactory({
          principal,
          tenantContext,
          correlationId,
          occurredAt: callbackAt.toISOString(),
        }),
      });
      if (consumed?.status !== 'consumed') {
        const code = consumed?.reason === 'provider_tenant_mismatch'
          || consumed?.reason === 'provider_binding_mismatch'
          ? 'MICROSOFT365_PROVIDER_TENANT_MISMATCH'
          : 'MICROSOFT365_CONSENT_UNAVAILABLE';
        throw new Microsoft365ConnectionConflictError(code);
      }

      let binding;
      try {
        binding = await bindingFor(tenantContext);
      } catch (error) {
        await recordConsentCallbackRejection({
          principal,
          tenantContext,
          correlationId,
          reasonCode: 'provider_binding_changed',
        });
        throw error;
      }
      if (consumed.providerTenantReference !== binding.providerTenantReference) {
        await recordConsentCallbackRejection({
          principal,
          tenantContext,
          correlationId,
          reasonCode: 'provider_binding_changed',
        });
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
      }
      if (callbackTenant !== null && callbackTenant !== binding.providerTenantReference) {
        await recordConsentCallbackRejection({
          principal,
          tenantContext,
          correlationId,
          reasonCode: 'provider_tenant_mismatch',
        });
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
      }

      if (!approved) {
        return finalizeVerification({
          tenantContext,
          consumed,
          providerTenantReference: consumed.providerTenantReference,
          verification: {
            status: MICROSOFT365_VERIFICATION.DEGRADED,
            places: 'unknown',
            calendars: 'unknown',
            reason: 'consent_denied',
          },
          approved: false,
          auditEvents: ({ status, reason, occurredAt }) => finalConsentAuditEvents({
            principal,
            tenantContext,
            correlationId,
            integrationId: consumed.integrationId,
            previousStatus: consumed.connectionStatus,
            finalStatus: status,
            reason: 'consent_denied',
            occurredAt,
            approved: false,
          }),
          bindingUnavailableAuditEvent: ({ occurredAt }) => consentRejectionAuditFactory({
            principal,
            tenantContext,
            correlationId,
            occurredAt,
          })({
            integrationId: consumed.integrationId,
            previousStatus: consumed.connectionStatus,
            reasonCode: 'provider_binding_changed',
          }),
        });
      }

      const verification = await providerClient.verifyBasePermissions({
        tenantReference: binding.providerTenantReference,
        claimantUserReference: binding.claimantProviderUserReference ?? null,
      });
      return finalizeVerification({
        tenantContext,
        consumed,
        providerTenantReference: consumed.providerTenantReference,
        verification,
        approved: true,
        auditEvents: ({ status, reason, occurredAt }) => finalConsentAuditEvents({
          principal,
          tenantContext,
          correlationId,
          integrationId: consumed.integrationId,
          previousStatus: consumed.connectionStatus,
          finalStatus: status,
          reason,
          occurredAt,
          approved: true,
        }),
        bindingUnavailableAuditEvent: ({ occurredAt }) => consentRejectionAuditFactory({
          principal,
          tenantContext,
          correlationId,
          occurredAt,
        })({
          integrationId: consumed.integrationId,
          previousStatus: consumed.connectionStatus,
          reasonCode: 'provider_binding_changed',
        }),
      });
    },

    async verifyConnection({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'verify' });
      const connection = await repository.findByTenantId(tenantContext.tenantId);
      if (!connection || connection.status === 'disconnected') return publicConnection(connection);
      const binding = await bindingFor(tenantContext);
      if (connection.providerTenantReference !== binding.providerTenantReference) {
        throw new Microsoft365ConnectionConflictError('MICROSOFT365_PROVIDER_TENANT_MISMATCH');
      }
      const verification = await providerClient.verifyBasePermissions({
        tenantReference: binding.providerTenantReference,
        claimantUserReference: binding.claimantProviderUserReference ?? null,
      });
      return finalizeVerification({
        tenantContext,
        consumed: {
          integrationId: connection.integrationId,
          connectionVersion: connection.connectionVersion,
        },
        providerTenantReference: connection.providerTenantReference,
        verification,
        approved: true,
        auditEvents: ({ status, reason, occurredAt }) => [verificationAuditEvent({
          principal,
          tenantContext,
          correlationId,
          integrationId: connection.integrationId,
          previousStatus: connection.status,
          finalStatus: status,
          reason,
          occurredAt,
        })],
        bindingUnavailableAuditEvent: ({ occurredAt }) => verificationAuditEvent({
          principal,
          tenantContext,
          correlationId,
          integrationId: connection.integrationId,
          previousStatus: connection.status,
          finalStatus: connection.status,
          reason: 'provider_binding_changed',
          occurredAt,
          outcome: AUDIT_OUTCOME.FAILURE,
        }),
      });
    },

    recordConsentCallbackRejection,

    async disconnect({ principal, tenantContext, correlationId }) {
      requireCorrelationId(correlationId);
      await authorize({ principal, tenantContext, correlationId, operation: 'disconnect' });
      const at = changedAt(clock);
      const connection = await repository.disconnect({
        tenantId: tenantContext.tenantId,
        changedAt: at,
        auditEventFor({ integrationId, previousStatus, nextStatus }) {
          return auditService.createEvent({
            principal,
            tenantContext,
            correlationId,
            action: AUDIT_ACTION.INTEGRATION_DISCONNECTED,
            targetType: 'integration',
            targetId: integrationId,
            previousState: { provider: 'microsoft365', status: previousStatus },
            newState: { provider: 'microsoft365', status: nextStatus },
            outcome: AUDIT_OUTCOME.SUCCESS,
            metadata: { operation: 'disconnect' },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: at.toISOString(),
          });
        },
      });
      return publicConnection(connection);
    },
  });
}
