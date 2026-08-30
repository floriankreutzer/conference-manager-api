import {
  authorizePlatformOperation,
  PLATFORM_OPERATION,
  requireClockTime,
  requireCount,
  requireCursor,
  requireDisplayName,
  requireExactObject,
  requireInternalId,
  requireLimit,
  requirePage,
  requirePort,
  requireRevision,
  requireSafeCode,
  requireTimestamp,
} from './platform-operation-contract.js';
import { PlatformOperationUnavailableError } from './platform-operation-errors.js';
import { freshnessForObservation } from './fleet-readiness-service.js';

const LIFECYCLE_STATUSES = new Set(['pending', 'onboarding', 'ready', 'active', 'suspended', 'archived']);

function unavailable(code) {
  throw new PlatformOperationUnavailableError(code);
}

function requireEnum(value, allowed, code) {
  if (typeof value !== 'string' || !allowed.has(value)) unavailable(code);
  return value;
}

function safeEnumSet(value, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) unavailable(code);
  const items = value.map((item) => requireSafeCode(item, code));
  if (new Set(items).size !== items.length) unavailable(code);
  return new Set(items);
}

function presentationContract(value) {
  requireExactObject(value, [
    'capabilities',
    'connectionStates',
    'permissionStates',
    'healthStatuses',
    'incidentScopes',
  ], undefined, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID');
  return Object.freeze({
    capabilities: safeEnumSet(value.capabilities, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID'),
    connectionStates: safeEnumSet(value.connectionStates, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID'),
    permissionStates: safeEnumSet(value.permissionStates, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID'),
    healthStatuses: safeEnumSet(value.healthStatuses, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID'),
    incidentScopes: safeEnumSet(value.incidentScopes, 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_CONTRACT_INVALID'),
  });
}

function capabilityHealth(value, asOfMs, contract) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable('PLATFORM_MICROSOFT_HEALTH_INVALID');
  const capability = requireEnum(value.capability, contract.capabilities, 'PLATFORM_MICROSOFT_HEALTH_INVALID');
  const checkedAt = value.checkedAt === null
    ? null
    : requireTimestamp(value.checkedAt, 'PLATFORM_MICROSOFT_HEALTH_INVALID');
  const freshUntil = value.freshUntil === null
    ? null
    : requireTimestamp(value.freshUntil, 'PLATFORM_MICROSOFT_HEALTH_INVALID');
  const lastSuccessAt = value.lastSuccessAt === null
    ? null
    : requireTimestamp(value.lastSuccessAt, 'PLATFORM_MICROSOFT_HEALTH_INVALID');
  if (lastSuccessAt !== null && checkedAt !== null && Date.parse(lastSuccessAt) > Date.parse(checkedAt)) {
    unavailable('PLATFORM_MICROSOFT_HEALTH_INVALID');
  }
  return Object.freeze({
    capability,
    status: requireEnum(value.status, contract.healthStatuses, 'PLATFORM_MICROSOFT_HEALTH_INVALID'),
    reasonCode: value.reasonCode === null
      ? null
      : requireSafeCode(value.reasonCode, 'PLATFORM_MICROSOFT_HEALTH_INVALID'),
    checkedAt,
    lastSuccessAt,
    freshness: freshnessForObservation({ observedAt: checkedAt, freshUntil }, asOfMs),
    incidentScope: requireEnum(value.incidentScope, contract.incidentScopes, 'PLATFORM_MICROSOFT_HEALTH_INVALID'),
  });
}

function healthRow(value, asOfMs, contract) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.capabilities)) {
    unavailable('PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  }
  if (value.capabilities.length > contract.capabilities.size) unavailable('PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  const capabilities = Object.freeze(value.capabilities.map((item) => capabilityHealth(item, asOfMs, contract)));
  if (new Set(capabilities.map((item) => item.capability)).size !== capabilities.length) {
    unavailable('PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  }
  const active = requireCount(value.activeMappingCount, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  const missing = requireCount(value.missingMappingCount, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  const total = requireCount(value.totalMappingCount, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  if (active + missing > total) unavailable('PLATFORM_MICROSOFT_HEALTH_ROW_INVALID');
  return Object.freeze({
    tenantId: requireInternalId(value.tenantId, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID'),
    displayName: requireDisplayName(value.displayName),
    lifecycle: Object.freeze({
      status: requireEnum(value.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID'),
      revision: requireRevision(value.lifecycleRevision, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID'),
    }),
    connectionState: requireEnum(
      value.connectionState,
      contract.connectionStates,
      'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID',
    ),
    permissions: Object.freeze({
      places: requireEnum(value.placesPermission, contract.permissionStates, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID'),
      calendars: requireEnum(value.calendarsPermission, contract.permissionStates, 'PLATFORM_MICROSOFT_HEALTH_ROW_INVALID'),
    }),
    mappings: Object.freeze({ active, missing, total }),
    capabilities,
  });
}

export function createPlatformMicrosoftFleetHealthService({
  healthSnapshotReader,
  healthPresentationPolicy,
  platformAuthorizationPolicy,
  tenantTargetPolicy,
  clock = () => Date.now(),
} = {}) {
  requirePort(healthSnapshotReader, ['list'], 'PLATFORM_MICROSOFT_HEALTH_SNAPSHOT_READER_REQUIRED');
  requirePort(healthPresentationPolicy, ['contract'], 'PLATFORM_MICROSOFT_HEALTH_PRESENTATION_POLICY_REQUIRED');
  requirePort(platformAuthorizationPolicy, ['authorize'], 'PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  requirePort(tenantTargetPolicy, ['queryScope'], 'PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('PLATFORM_OPERATION_CLOCK_REQUIRED');

  return Object.freeze({
    async listFleetHealth(input) {
      requireExactObject(input, ['operatorContext', 'query']);
      requireExactObject(
        input.query,
        ['limit', 'cursor', 'lifecycleStatus', 'capability', 'healthStatus', 'incidentScope'],
        [],
        'PLATFORM_MICROSOFT_HEALTH_QUERY_INVALID',
      );
      const queryBase = {
        limit: requireLimit(input.query.limit),
        cursor: input.query.cursor === undefined ? null : requireCursor(input.query.cursor),
        lifecycleStatus: input.query.lifecycleStatus === undefined
          ? null
          : requireEnum(input.query.lifecycleStatus, LIFECYCLE_STATUSES, 'PLATFORM_MICROSOFT_HEALTH_QUERY_INVALID'),
      };
      const authorization = await authorizePlatformOperation({
        authorizationPolicy: platformAuthorizationPolicy,
        tenantTargetPolicy,
        operatorContext: input.operatorContext,
        operation: PLATFORM_OPERATION.MICROSOFT_HEALTH_READ,
        fleet: true,
      });
      const contract = presentationContract(await healthPresentationPolicy.contract());
      const query = Object.freeze({
        ...queryBase,
        capability: input.query.capability === undefined
          ? null
          : requireEnum(input.query.capability, contract.capabilities, 'PLATFORM_MICROSOFT_HEALTH_QUERY_INVALID'),
        healthStatus: input.query.healthStatus === undefined
          ? null
          : requireEnum(input.query.healthStatus, contract.healthStatuses, 'PLATFORM_MICROSOFT_HEALTH_QUERY_INVALID'),
        incidentScope: input.query.incidentScope === undefined
          ? null
          : requireEnum(input.query.incidentScope, contract.incidentScopes, 'PLATFORM_MICROSOFT_HEALTH_QUERY_INVALID'),
      });
      const page = requirePage(await healthSnapshotReader.list({ query, authorization }));
      if (page.items.length > query.limit) unavailable('PLATFORM_MICROSOFT_HEALTH_PAGE_INVALID');
      const asOfMs = Date.parse(page.snapshotAt);
      if (asOfMs > requireClockTime(clock) + 60_000) unavailable('PLATFORM_MICROSOFT_HEALTH_SNAPSHOT_INVALID');
      return Object.freeze({
        schemaVersion: 1,
        snapshotAt: page.snapshotAt,
        items: Object.freeze(page.items.map((item) => healthRow(item, asOfMs, contract))),
        nextCursor: page.nextCursor,
      });
    },
  });
}
