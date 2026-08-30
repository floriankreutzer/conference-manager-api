import { isInternalUuid } from '../../domain/identifiers.js';
import { isKnownPlatformPermission, permissionsForPlatformRoles } from '../identity/policy.js';
import { PlatformAuditInputError } from './errors.js';

export const PLATFORM_AUDIT_ACTION = Object.freeze({
  AUTHENTICATION_SUCCEEDED: 'platform.authentication.succeeded',
  AUTHENTICATION_FAILED: 'platform.authentication.failed',
  AUTHORIZATION_DENIED: 'platform.authorization.denied',
  SESSION_ISSUED: 'platform.session.issued',
  SESSION_ROTATED: 'platform.session.rotated',
  SESSION_REVOKED: 'platform.session.revoked',
  SESSION_EPOCH_REJECTED: 'platform.session.epoch_rejected',
  BREAK_GLASS_GRANTED: 'platform.break_glass.granted',
  BREAK_GLASS_REVOKED: 'platform.break_glass.revoked',
  BREAK_GLASS_USED: 'platform.break_glass.used',
  BREAK_GLASS_DENIED: 'platform.break_glass.denied',
  TENANT_DIRECTORY_READ: 'platform.tenant.directory.read',
  TENANT_REGISTRATION_CHANGED: 'platform.tenant.registration.changed',
  TENANT_INVITATION_CHANGED: 'platform.tenant.invitation.changed',
  TENANT_LIFECYCLE_CHANGED: 'platform.tenant.lifecycle.changed',
  TENANT_ENTITLEMENT_CHANGED: 'platform.tenant.entitlement.changed',
  TENANT_QUOTA_CHANGED: 'platform.tenant.quota.changed',
  TENANT_CONFIGURATION_CHANGED: 'platform.tenant.configuration.changed',
  TENANT_INTEGRATION_CHANGED: 'platform.tenant.integration.changed',
  TENANT_READINESS_READ: 'platform.tenant.readiness.read',
  DIAGNOSTICS_READ: 'platform.diagnostics.read',
  METERING_READ: 'platform.metering.read',
  RUNTIME_READ: 'platform.runtime.read',
  RECOVERY_PREVIEWED: 'platform.recovery.previewed',
  RECOVERY_EXECUTED: 'platform.recovery.executed',
  AUDIT_READ: 'platform.audit.read',
  AUDIT_EXPORTED: 'platform.audit.exported',
  OPERATOR_CHANGED: 'platform.operator.changed',
});

export const PLATFORM_AUDIT_OUTCOME = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
});

export const PLATFORM_AUDIT_RETENTION = Object.freeze({
  SECURITY: 'security',
  ADMINISTRATIVE: 'administrative',
  RECOVERY: 'recovery',
});

const ACTIONS = new Set(Object.values(PLATFORM_AUDIT_ACTION));
const OUTCOMES = new Set(Object.values(PLATFORM_AUDIT_OUTCOME));
const RETENTIONS = new Set(Object.values(PLATFORM_AUDIT_RETENTION));
const TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
const FORBIDDEN_KEY = /(password|secret|token|cookie|csrf|authorization|credential|private.?key|session.?id|subject|email)/i;
const MAX_JSON_BYTES = 4_096;

function invalid(code = 'PLATFORM_AUDIT_EVENT_INVALID') {
  throw new PlatformAuditInputError(code);
}

function safeObject(value, code) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 16) invalid(code);
  const normalized = {};
  for (const [key, entry] of entries) {
    if (!SAFE_KEY_PATTERN.test(key) || FORBIDDEN_KEY.test(key)) invalid(code);
    if (
      !['string', 'number', 'boolean'].includes(typeof entry)
      && entry !== null
    ) invalid(code);
    if (typeof entry === 'number' && !Number.isFinite(entry)) invalid(code);
    if (
      typeof entry === 'string'
      && (entry.length > 512 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry))
    ) invalid(code);
    normalized[key] = entry;
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_JSON_BYTES) invalid(code);
  return Object.freeze(normalized);
}

function stringSnapshot(values, { allowEmpty = true, permissions = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > 32) invalid();
  if (values.some((value) => typeof value !== 'string')) invalid();
  if (new Set(values).size !== values.length) invalid();
  const normalized = Object.freeze([...values].sort());
  if (permissions && normalized.some((permission) => !isKnownPlatformPermission(permission))) invalid();
  return normalized;
}

function utcInstant(value) {
  if (typeof value !== 'string' || !value.endsWith('Z') || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}

export function normalizePlatformAuditEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (value.operatorId !== null && !isInternalUuid(value.operatorId)) invalid();
  if (value.targetTenantId !== null && !isInternalUuid(value.targetTenantId)) invalid();
  if (!ACTIONS.has(value.action) || !OUTCOMES.has(value.outcome) || !RETENTIONS.has(value.retentionClass)) invalid();
  if (!TARGET_TYPE_PATTERN.test(value.targetType || '') || !TARGET_ID_PATTERN.test(value.targetId || '')) invalid();
  if (!isInternalUuid(value.correlationId)) invalid();
  const roles = stringSnapshot(value.roles || []);
  const permissions = stringSnapshot(value.permissions || [], { permissions: true });
  if (value.operatorId === null) {
    if (
      value.action !== PLATFORM_AUDIT_ACTION.AUTHENTICATION_FAILED
      || roles.length !== 0
      || permissions.length !== 0
      || value.assuranceLevel !== 'unverified'
    ) invalid();
  } else {
    let expected;
    try {
      expected = permissionsForPlatformRoles(roles);
    } catch {
      invalid();
    }
    if (expected.length !== permissions.length || expected.some((entry, index) => entry !== permissions[index])) invalid();
    if (!['mfa', 'step_up', 'break_glass'].includes(value.assuranceLevel)) invalid();
  }
  return Object.freeze({
    operatorId: value.operatorId,
    roles,
    permissions,
    assuranceLevel: value.assuranceLevel,
    targetTenantId: value.targetTenantId,
    action: value.action,
    targetType: value.targetType,
    targetId: value.targetId,
    previousState: safeObject(value.previousState ?? null, 'PLATFORM_AUDIT_PREVIOUS_STATE_INVALID'),
    newState: safeObject(value.newState ?? null, 'PLATFORM_AUDIT_NEW_STATE_INVALID'),
    occurredAt: utcInstant(value.occurredAt),
    correlationId: value.correlationId,
    outcome: value.outcome,
    metadata: safeObject(value.metadata ?? {}, 'PLATFORM_AUDIT_METADATA_INVALID'),
    retentionClass: value.retentionClass,
  });
}

export function canonicalPlatformAuditPayload(event, { sequence, previousHash = null } = {}) {
  const normalized = normalizePlatformAuditEvent(event);
  if (!Number.isSafeInteger(sequence) || sequence < 1) invalid();
  if (previousHash !== null && !/^[0-9a-f]{64}$/.test(previousHash)) invalid();
  return JSON.stringify({
    integrityVersion: 1,
    sequence,
    previousHash,
    ...normalized,
  });
}

export function canonicalPlatformAuditCheckpoint(value) {
  if (
    !value
    || !Number.isSafeInteger(value.eventCount)
    || value.eventCount < 1
    || !/^[0-9a-f]{64}$/.test(value.terminalEventHash || '')
    || (value.previousCheckpointHash !== null && !/^[0-9a-f]{64}$/.test(value.previousCheckpointHash || ''))
    || typeof value.createdAt !== 'string'
    || !value.createdAt.endsWith('Z')
    || !Number.isFinite(Date.parse(value.createdAt))
  ) invalid('PLATFORM_AUDIT_CHECKPOINT_INVALID');
  return JSON.stringify({
    integrityVersion: 1,
    eventCount: value.eventCount,
    terminalEventHash: value.terminalEventHash,
    previousCheckpointHash: value.previousCheckpointHash,
    createdAt: value.createdAt,
  });
}
