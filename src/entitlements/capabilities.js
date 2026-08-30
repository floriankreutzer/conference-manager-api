import { EntitlementInputError } from './errors.js';
import {
  CapabilityDependencyPolicyError,
  requireCapabilityDependencyClosure as requireDependencyClosure,
} from '../domain/capability-dependency-policy.js';

export const CAPABILITY = Object.freeze({
  MICROSOFT_DIRECTORY: 'microsoft.directory',
  MICROSOFT_CALENDAR: 'microsoft.calendar',
  MICROSOFT_CALENDAR_WRITE: 'microsoft.calendar.write',
});

export const ROLLOUT_STATE = Object.freeze({
  NOT_CONTROLLED: 'not_controlled',
  ENABLED: 'enabled',
  DISABLED: 'disabled',
});

const KNOWN_CAPABILITIES = new Set(Object.values(CAPABILITY));
const KNOWN_ROLLOUT_STATES = new Set(Object.values(ROLLOUT_STATE));

export const CAPABILITY_DESCRIPTORS = Object.freeze([
  Object.freeze({ capabilityId: CAPABILITY.MICROSOFT_DIRECTORY, dependencies: Object.freeze([]) }),
  Object.freeze({
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR,
    dependencies: Object.freeze([CAPABILITY.MICROSOFT_DIRECTORY]),
  }),
  Object.freeze({
    capabilityId: CAPABILITY.MICROSOFT_CALENDAR_WRITE,
    dependencies: Object.freeze([CAPABILITY.MICROSOFT_CALENDAR]),
  }),
]);

export function isKnownCapability(value) {
  return typeof value === 'string' && KNOWN_CAPABILITIES.has(value);
}

export function normalizeCapabilityId(value) {
  if (!isKnownCapability(value)) throw new EntitlementInputError('CAPABILITY_UNKNOWN');
  return value;
}

export function isRolloutState(value) {
  return typeof value === 'string' && KNOWN_ROLLOUT_STATES.has(value);
}

export function listCapabilityDescriptors() {
  return CAPABILITY_DESCRIPTORS;
}

export function createCapabilityPolicy() {
  return Object.freeze({ async list() { return listCapabilityDescriptors(); } });
}

export function requireCapabilityDependencyClosure(entries) {
  try {
    return requireDependencyClosure(entries, CAPABILITY_DESCRIPTORS);
  } catch (error) {
    if (error instanceof CapabilityDependencyPolicyError) {
      throw new EntitlementInputError(error.code);
    }
    throw error;
  }
}

export function evaluateEffectiveCapability({ authorized, entitled, rolloutState = ROLLOUT_STATE.NOT_CONTROLLED }) {
  if (typeof authorized !== 'boolean' || typeof entitled !== 'boolean' || !isRolloutState(rolloutState)) {
    throw new EntitlementInputError('CAPABILITY_EVALUATION_INVALID');
  }
  return authorized && entitled && rolloutState !== ROLLOUT_STATE.DISABLED;
}
