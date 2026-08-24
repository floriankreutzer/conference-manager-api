import { isInternalUuid } from '../domain/identifiers.js';

export const TENANT_STATUS = Object.freeze({
  PENDING: 'pending',
  ONBOARDING: 'onboarding',
  READY: 'ready',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
});

export const TENANT_OWNED_RESOURCE_TYPES = Object.freeze([
  'user',
  'site',
  'room',
  'service',
  'catering_package',
  'catering_item',
  'request',
  'notification',
  'integration',
  'entitlement',
  'booking_provider_reference',
  'tenant_onboarding_invitation',
  'tenant_identity_binding',
  'audit_event',
  'tenant_configuration',
]);

const TENANT_STATUSES = new Set(Object.values(TENANT_STATUS));
const SESSION_AVAILABLE_STATUSES = new Set([
  TENANT_STATUS.PENDING,
  TENANT_STATUS.ONBOARDING,
  TENANT_STATUS.READY,
  TENANT_STATUS.ACTIVE,
]);
const REQUIRED_FIELDS = new Set(['id', 'displayName', 'status', 'createdAt', 'updatedAt']);

function isDisplayName(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 160
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isUtcInstant(value) {
  return typeof value === 'string'
    && value.endsWith('Z')
    && Number.isFinite(Date.parse(value));
}

export function normalizeTenant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('TENANT_INVALID');
  }
  const keys = Object.keys(value);
  if (keys.length !== REQUIRED_FIELDS.size || keys.some((key) => !REQUIRED_FIELDS.has(key))) {
    throw new TypeError('TENANT_INVALID');
  }
  if (!isInternalUuid(value.id) || !isDisplayName(value.displayName)) {
    throw new TypeError('TENANT_INVALID');
  }
  if (!TENANT_STATUSES.has(value.status)) throw new TypeError('TENANT_INVALID');
  if (!isUtcInstant(value.createdAt) || !isUtcInstant(value.updatedAt)) {
    throw new TypeError('TENANT_INVALID');
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new TypeError('TENANT_INVALID');
  }
  return Object.freeze({
    id: value.id,
    displayName: value.displayName,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function isTenantSessionAvailable(tenant) {
  return SESSION_AVAILABLE_STATUSES.has(tenant.status);
}

export function isTenantBusinessActive(tenant) {
  return tenant.status === TENANT_STATUS.ACTIVE;
}
