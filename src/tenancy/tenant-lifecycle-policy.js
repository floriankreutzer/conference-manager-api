export const TENANT_LIFECYCLE_STATUS = Object.freeze({
  PENDING: 'pending',
  ONBOARDING: 'onboarding',
  READY: 'ready',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
});

const TRANSITIONS = Object.freeze({
  [TENANT_LIFECYCLE_STATUS.PENDING]: new Set(),
  [TENANT_LIFECYCLE_STATUS.ONBOARDING]: new Set([TENANT_LIFECYCLE_STATUS.READY]),
  [TENANT_LIFECYCLE_STATUS.READY]: new Set([TENANT_LIFECYCLE_STATUS.ACTIVE]),
  [TENANT_LIFECYCLE_STATUS.ACTIVE]: new Set([TENANT_LIFECYCLE_STATUS.SUSPENDED]),
  [TENANT_LIFECYCLE_STATUS.SUSPENDED]: new Set([TENANT_LIFECYCLE_STATUS.ACTIVE]),
  [TENANT_LIFECYCLE_STATUS.ARCHIVED]: new Set(),
});

export function isTenantLifecycleTransitionAllowed({ currentStatus, targetStatus } = {}) {
  return TRANSITIONS[currentStatus]?.has(targetStatus) === true;
}

export function requireTenantLifecycleTransition(values) {
  if (!isTenantLifecycleTransitionAllowed(values)) {
    const error = new TypeError('TENANT_LIFECYCLE_TRANSITION_DENIED');
    error.code = error.message;
    throw error;
  }
  return true;
}

export function createTenantLifecyclePolicy() {
  return Object.freeze({ requireTransition: requireTenantLifecycleTransition });
}

