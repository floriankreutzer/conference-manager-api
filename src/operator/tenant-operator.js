import { isAbsolute } from 'node:path';
import { isInternalUuid } from '../domain/identifiers.js';
import { isKnownCapability } from '../entitlements/capabilities.js';

const COMMAND = Object.freeze({
  INVITE: 'invite',
  READINESS: 'readiness',
  ENTITLEMENT: 'entitlement',
  LIFECYCLE: 'lifecycle',
  UNBIND_IDENTITY: 'unbind-identity',
});
const ENVIRONMENTS = new Set(['pilot', 'production']);
const LIFECYCLE_TARGETS = new Set(['ready', 'active', 'suspended']);
const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TENANT_STATUSES = new Set([
  'pending',
  'onboarding',
  'ready',
  'active',
  'suspended',
  'archived',
]);
const READINESS_CHECKS = Object.freeze([
  'tenantIdentityClaimed',
  'microsoft365Connected',
  'placesPermissionGranted',
  'calendarPermissionGranted',
  'roomImported',
  'freeBusyVerified',
  'directoryEntitled',
  'calendarEntitled',
]);
const READINESS_ENTITLEMENTS = Object.freeze([
  'microsoftDirectory',
  'microsoftCalendar',
  'microsoftCalendarWrite',
]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export class TenantOperatorInputError extends Error {
  constructor(code = 'TENANT_OPERATOR_INPUT_INVALID') {
    super(code);
    this.name = 'TenantOperatorInputError';
    this.code = code;
  }
}

function invalid(code) {
  throw new TenantOperatorInputError(code);
}

function parseFlags(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    invalid('TENANT_OPERATOR_ARGUMENTS_INVALID');
  }
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!/^--[a-z][a-z0-9-]*$/.test(token)) {
      invalid('TENANT_OPERATOR_ARGUMENT_INVALID');
    }
    const key = token.slice(2);
    if (flags.has(key)) invalid('TENANT_OPERATOR_ARGUMENT_DUPLICATE');
    if (key === 'apply') {
      flags.set(key, true);
      continue;
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || value.startsWith('--')) {
      invalid('TENANT_OPERATOR_ARGUMENT_VALUE_REQUIRED');
    }
    flags.set(key, value);
    index += 1;
  }
  return flags;
}

function assertAllowedFlags(flags, allowed) {
  for (const key of flags.keys()) {
    if (!allowed.has(key)) invalid('TENANT_OPERATOR_ARGUMENT_UNSUPPORTED');
  }
}

function requiredFlag(flags, key) {
  const value = flags.get(key);
  if (typeof value !== 'string') invalid('TENANT_OPERATOR_ARGUMENT_REQUIRED');
  return value;
}

function boundedText(value, { max, code }) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > max
    || value.trim() !== value
    || CONTROL_CHARACTER.test(value)
  ) {
    invalid(code);
  }
  return value;
}

function environmentFlag(flags) {
  const value = requiredFlag(flags, 'environment');
  if (!ENVIRONMENTS.has(value)) invalid('TENANT_OPERATOR_ENVIRONMENT_INVALID');
  return value;
}

function correlationFlag(flags) {
  const value = requiredFlag(flags, 'correlation-id');
  if (!isInternalUuid(value)) invalid('TENANT_OPERATOR_CORRELATION_INVALID');
  return value;
}

function tenantFlag(flags) {
  const value = requiredFlag(flags, 'tenant-id');
  if (!isInternalUuid(value)) invalid('TENANT_OPERATOR_TENANT_INVALID');
  return value;
}

function booleanFlag(flags, key) {
  const value = requiredFlag(flags, key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  invalid('TENANT_OPERATOR_BOOLEAN_INVALID');
}

function requireMutationGate(flags, expectedConfirmation) {
  if (flags.get('apply') !== true) invalid('TENANT_OPERATOR_APPLY_REQUIRED');
  if (requiredFlag(flags, 'confirm') !== expectedConfirmation) {
    invalid('TENANT_OPERATOR_CONFIRMATION_INVALID');
  }
}

function invitationCommand(flags) {
  assertAllowedFlags(flags, new Set([
    'environment',
    'correlation-id',
    'display-name',
    'output',
    'confirm',
    'apply',
  ]));
  const environment = environmentFlag(flags);
  const correlationId = correlationFlag(flags);
  const displayName = boundedText(requiredFlag(flags, 'display-name'), {
    max: 160,
    code: 'TENANT_OPERATOR_DISPLAY_NAME_INVALID',
  });
  const outputPath = boundedText(requiredFlag(flags, 'output'), {
    max: 1_024,
    code: 'TENANT_OPERATOR_OUTPUT_INVALID',
  });
  if (!isAbsolute(outputPath)) invalid('TENANT_OPERATOR_OUTPUT_ABSOLUTE_REQUIRED');
  requireMutationGate(flags, COMMAND.INVITE);
  return Object.freeze({
    kind: COMMAND.INVITE,
    environment,
    correlationId,
    displayName,
    outputPath,
  });
}

function readinessCommand(flags) {
  assertAllowedFlags(flags, new Set(['environment', 'correlation-id', 'tenant-id']));
  return Object.freeze({
    kind: COMMAND.READINESS,
    environment: environmentFlag(flags),
    correlationId: correlationFlag(flags),
    tenantId: tenantFlag(flags),
  });
}

function entitlementCommand(flags) {
  assertAllowedFlags(flags, new Set([
    'environment',
    'correlation-id',
    'tenant-id',
    'capability',
    'enabled',
    'confirm',
    'apply',
  ]));
  const environment = environmentFlag(flags);
  const correlationId = correlationFlag(flags);
  const tenantId = tenantFlag(flags);
  const capabilityId = requiredFlag(flags, 'capability');
  if (!isKnownCapability(capabilityId)) invalid('TENANT_OPERATOR_CAPABILITY_INVALID');
  const enabled = booleanFlag(flags, 'enabled');
  const expected = `${COMMAND.ENTITLEMENT}:${tenantId}:${capabilityId}:${enabled}`;
  requireMutationGate(flags, expected);
  return Object.freeze({
    kind: COMMAND.ENTITLEMENT,
    environment,
    correlationId,
    tenantId,
    capabilityId,
    enabled,
  });
}

function lifecycleCommand(flags) {
  assertAllowedFlags(flags, new Set([
    'environment',
    'correlation-id',
    'tenant-id',
    'target',
    'confirm',
    'apply',
  ]));
  const environment = environmentFlag(flags);
  const correlationId = correlationFlag(flags);
  const tenantId = tenantFlag(flags);
  const targetStatus = requiredFlag(flags, 'target');
  if (!LIFECYCLE_TARGETS.has(targetStatus)) invalid('TENANT_OPERATOR_LIFECYCLE_INVALID');
  requireMutationGate(flags, `${COMMAND.LIFECYCLE}:${tenantId}:${targetStatus}`);
  return Object.freeze({
    kind: COMMAND.LIFECYCLE,
    environment,
    correlationId,
    tenantId,
    targetStatus,
  });
}

function unbindIdentityCommand(flags) {
  assertAllowedFlags(flags, new Set([
    'environment',
    'correlation-id',
    'tenant-id',
    'reason',
    'confirm',
    'apply',
  ]));
  const environment = environmentFlag(flags);
  const correlationId = correlationFlag(flags);
  const tenantId = tenantFlag(flags);
  const reason = boundedText(requiredFlag(flags, 'reason'), {
    max: 500,
    code: 'TENANT_OPERATOR_REASON_INVALID',
  });
  requireMutationGate(flags, `${COMMAND.UNBIND_IDENTITY}:${tenantId}`);
  return Object.freeze({
    kind: COMMAND.UNBIND_IDENTITY,
    environment,
    correlationId,
    tenantId,
    reason,
  });
}

export function parseTenantOperatorCommand(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') {
    invalid('TENANT_OPERATOR_COMMAND_REQUIRED');
  }
  const [command, ...args] = argv;
  const flags = parseFlags(args);
  if (command === COMMAND.INVITE) return invitationCommand(flags);
  if (command === COMMAND.READINESS) return readinessCommand(flags);
  if (command === COMMAND.ENTITLEMENT) return entitlementCommand(flags);
  if (command === COMMAND.LIFECYCLE) return lifecycleCommand(flags);
  if (command === COMMAND.UNBIND_IDENTITY) return unbindIdentityCommand(flags);
  invalid('TENANT_OPERATOR_COMMAND_INVALID');
}

function requireService(services, name, method) {
  const service = services?.[name];
  if (!service || typeof service[method] !== 'function') {
    throw new TypeError('TENANT_OPERATOR_SERVICE_REQUIRED');
  }
  return service;
}

export async function executeTenantOperatorCommand({ command, operatorContext, services } = {}) {
  if (!command || typeof command !== 'object' || !operatorContext || typeof operatorContext !== 'object') {
    throw new TypeError('TENANT_OPERATOR_EXECUTION_INVALID');
  }
  if (command.kind === COMMAND.INVITE) {
    return requireService(services, 'onboarding', 'createTenantInvitation').createTenantInvitation({
      operatorContext,
      displayName: command.displayName,
      correlationId: command.correlationId,
    });
  }
  if (command.kind === COMMAND.READINESS) {
    return requireService(services, 'pilot', 'readinessForTenant').readinessForTenant(command.tenantId);
  }
  if (command.kind === COMMAND.ENTITLEMENT) {
    return requireService(services, 'entitlement', 'setEntitlement').setEntitlement({
      operatorContext,
      tenantId: command.tenantId,
      capabilityId: command.capabilityId,
      enabled: command.enabled,
      correlationId: command.correlationId,
    });
  }
  if (command.kind === COMMAND.LIFECYCLE) {
    return requireService(services, 'pilot', 'setLifecycle').setLifecycle({
      operatorContext,
      tenantId: command.tenantId,
      targetStatus: command.targetStatus,
      correlationId: command.correlationId,
    });
  }
  if (command.kind === COMMAND.UNBIND_IDENTITY) {
    return requireService(services, 'onboarding', 'unbindTenantIdentity').unbindTenantIdentity({
      operatorContext,
      tenantId: command.tenantId,
      correlationId: command.correlationId,
      reason: command.reason,
    });
  }
  throw new TypeError('TENANT_OPERATOR_COMMAND_INVALID');
}

function validUtcInstant(value) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value));
}

export function normalizeInvitationResult(value) {
  if (
    !value
    || typeof value !== 'object'
    || !isInternalUuid(value.tenantId)
    || !INVITATION_TOKEN_PATTERN.test(value.invitationToken || '')
    || !validUtcInstant(value.expiresAt)
  ) {
    throw new TypeError('TENANT_OPERATOR_INVITATION_RESULT_INVALID');
  }
  return Object.freeze({
    tenantId: value.tenantId,
    invitationToken: value.invitationToken,
    expiresAt: value.expiresAt,
  });
}

function normalizedBooleanRecord(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(code);
  }
  const result = {};
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') throw new TypeError(code);
    result[key] = value[key];
  }
  return Object.freeze(result);
}

function normalizeReadiness(value) {
  if (
    !value
    || typeof value !== 'object'
    || !TENANT_STATUSES.has(value.tenantStatus)
    || typeof value.ready !== 'boolean'
  ) {
    throw new TypeError('TENANT_OPERATOR_READINESS_RESULT_INVALID');
  }
  return Object.freeze({
    tenantStatus: value.tenantStatus,
    ready: value.ready,
    checks: normalizedBooleanRecord(
      value.checks,
      READINESS_CHECKS,
      'TENANT_OPERATOR_READINESS_RESULT_INVALID',
    ),
    entitlements: normalizedBooleanRecord(
      value.entitlements,
      READINESS_ENTITLEMENTS,
      'TENANT_OPERATOR_READINESS_RESULT_INVALID',
    ),
  });
}

export function publicTenantOperatorResult(command, value) {
  if (!command || typeof command !== 'object' || !isInternalUuid(command.correlationId)) {
    throw new TypeError('TENANT_OPERATOR_RESULT_INVALID');
  }
  if (command.kind === COMMAND.READINESS) {
    return Object.freeze({
      status: 'completed',
      command: command.kind,
      correlationId: command.correlationId,
      readiness: normalizeReadiness(value),
    });
  }
  return Object.freeze({
    status: 'completed',
    command: command.kind,
    correlationId: command.correlationId,
  });
}

export const TENANT_OPERATOR_COMMAND = COMMAND;
