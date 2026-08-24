import { isInternalUuid } from '../domain/identifiers.js';
import { AuditInputError } from './errors.js';

export const AUDIT_ACTION = Object.freeze({
  SESSION_ISSUED: 'session.issued',
  SESSION_REVOKED: 'session.revoked',
  SESSION_ROTATED: 'session.rotated',
  AUTHENTICATION_FAILED: 'authentication.failed',
  AUTHORIZATION_DENIED: 'authorization.denied',
  REQUEST_TRANSITION: 'request.transition',
  REQUEST_TRANSITION_FAILED: 'request.transition_failed',
  TENANT_CONFIGURATION_CHANGED: 'tenant.configuration.changed',
  TENANT_USER_PERMISSIONS_CHANGED: 'tenant.user_permissions.changed',
  TENANT_ENTITLEMENT_CHANGED: 'tenant.entitlement.changed',
  TENANT_ONBOARDING_INVITED: 'tenant.onboarding.invited',
  TENANT_IDENTITY_CLAIMED: 'tenant.identity.claimed',
  TENANT_IDENTITY_UNBOUND: 'tenant.identity.unbound',
  TENANT_USER_PROVISIONED: 'tenant.user.provisioned',
  TENANT_USER_PROFILE_UPDATED: 'tenant.user.profile_updated',
  INTEGRATION_CONNECTED: 'integration.connected',
  INTEGRATION_DISCONNECTED: 'integration.disconnected',
  INTEGRATION_ADMIN_CONSENT_CHANGED: 'integration.admin_consent.changed',
  CALENDAR_OPERATION: 'calendar.operation',
  AUDIT_READ: 'audit.read',
});

export const AUDIT_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
});

export const AUDIT_RETENTION_CLASS = Object.freeze({
  SECURITY: 'security',
  BUSINESS: 'business',
  ADMINISTRATIVE: 'administrative',
});

const ACTIONS = new Set(Object.values(AUDIT_ACTION));
const OUTCOMES = new Set(Object.values(AUDIT_OUTCOME));
const RETENTION_CLASSES = new Set(Object.values(AUDIT_RETENTION_CLASS));
const TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const FORBIDDEN_KEY = /(password|secret|token|cookie|csrf|authorization|credential|private.?key|session.?id)/i;
const MAX_JSON_BYTES = 4_096;

function invalid(code = 'AUDIT_EVENT_INVALID') {
  throw new AuditInputError(code);
}

function isUtcInstant(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

function validateSafeObject(value, code) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const normalized = {};
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 16) invalid(code);
  for (const [key, entry] of entries) {
    if (!SAFE_KEY_PATTERN.test(key) || FORBIDDEN_KEY.test(key)) invalid(code);
    if (
      typeof entry !== 'string'
      && typeof entry !== 'number'
      && typeof entry !== 'boolean'
      && entry !== null
    ) {
      invalid(code);
    }
    if (typeof entry === 'string') {
      if (entry.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry)) invalid(code);
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) invalid(code);
    normalized[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_JSON_BYTES) invalid(code);
  return Object.freeze(normalized);
}

export function normalizeAuditEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (!isInternalUuid(value.tenantId)) invalid();
  if (value.actorUserId !== null && !isInternalUuid(value.actorUserId)) invalid();
  if (!ACTIONS.has(value.action) || !OUTCOMES.has(value.outcome)) invalid();
  if (!TARGET_TYPE_PATTERN.test(value.targetType || '') || !TARGET_ID_PATTERN.test(value.targetId || '')) invalid();
  if (!isUtcInstant(value.occurredAt) || !isInternalUuid(value.correlationId)) invalid();
  if (!RETENTION_CLASSES.has(value.retentionClass)) invalid();

  return Object.freeze({
    tenantId: value.tenantId,
    actorUserId: value.actorUserId,
    action: value.action,
    targetType: value.targetType,
    targetId: value.targetId,
    previousState: validateSafeObject(value.previousState ?? null, 'AUDIT_PREVIOUS_STATE_INVALID'),
    newState: validateSafeObject(value.newState ?? null, 'AUDIT_NEW_STATE_INVALID'),
    occurredAt: value.occurredAt,
    correlationId: value.correlationId,
    outcome: value.outcome,
    metadata: validateSafeObject(value.metadata ?? {}, 'AUDIT_METADATA_INVALID'),
    retentionClass: value.retentionClass,
  });
}

export function canonicalAuditPayload(event, previousHash = null) {
  const normalized = normalizeAuditEvent(event);
  return JSON.stringify({
    integrityVersion: 1,
    previousHash,
    tenantId: normalized.tenantId,
    actorUserId: normalized.actorUserId,
    action: normalized.action,
    targetType: normalized.targetType,
    targetId: normalized.targetId,
    previousState: normalized.previousState,
    newState: normalized.newState,
    occurredAt: normalized.occurredAt,
    correlationId: normalized.correlationId,
    outcome: normalized.outcome,
    metadata: normalized.metadata,
    retentionClass: normalized.retentionClass,
  });
}
