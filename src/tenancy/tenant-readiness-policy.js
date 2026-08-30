export const TENANT_READINESS_CHECK = Object.freeze({
  IDENTITY_ACTIVE: 'tenant.identity.active',
  MICROSOFT_CONNECTED: 'microsoft.connection.connected',
  PLACES_PERMISSION: 'microsoft.permission.places',
  CALENDARS_PERMISSION: 'microsoft.permission.calendars',
  ROOM_MAPPING_ACTIVE: 'microsoft.room_mapping.active',
  FREE_BUSY_HEALTHY: 'microsoft.free_busy.healthy',
  DIRECTORY_ENTITLED: 'entitlement.microsoft_directory',
  CALENDAR_ENTITLED: 'entitlement.microsoft_calendar',
});

export const TENANT_ACTIVATION_CAPABILITIES = Object.freeze([
  'microsoft.directory',
  'microsoft.calendar',
]);

const ACTIVATION_CHECKS = Object.freeze(Object.values(TENANT_READINESS_CHECK));

export function requiredTenantReadinessCheckIds({ lifecycleStatus } = {}) {
  if (!['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived'].includes(lifecycleStatus)) {
    throw new TypeError('TENANT_READINESS_LIFECYCLE_INVALID');
  }
  return ACTIVATION_CHECKS;
}

export function createTenantReadinessPolicy() {
  return Object.freeze({ requiredCheckIds: requiredTenantReadinessCheckIds });
}

