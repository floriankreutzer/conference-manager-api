import { randomUUID } from 'node:crypto';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringConfiguration } from '../integrations/catering-configuration.js';
import { isTenantSessionAvailable } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { TenantSettingsConflictError, TenantSettingsInputError } from './tenant-settings-errors.js';
import {
  nextTenantSettingsRevision,
  requireTenantSettingsRevision,
  requireTenantSettingsSchemaVersion,
} from './tenant-settings-revision.js';

function unavailable() {
  return new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}

function requireUuid(value) {
  if (!isInternalUuid(value)) throw new TenantSettingsInputError('CATERING_CONFIGURATION_IDENTIFIER_INVALID');
  return value.toLowerCase();
}

function configurationInput(value, descriptor) {
  try {
    const configuration = normalizeCateringConfiguration(value, descriptor);
    return Object.freeze({ initialOrderMode: configuration.initialOrderMode, capabilities: configuration.capabilities });
  } catch {
    throw new TenantSettingsInputError('CATERING_CONFIGURATION_INVALID');
  }
}

export function createCateringConfigurationService({
  repository, registry, authorizationPolicy, auditService, clock = Date.now, idFactory = randomUUID,
} = {}) {
  if (!repository || !['loadCurrent', 'update'].every((name) => typeof repository[name] === 'function')) {
    throw new TypeError('CATERING_CONFIGURATION_REPOSITORY_REQUIRED');
  }
  if (!registry || typeof registry.get !== 'function') throw new TypeError('PROVIDER_REGISTRY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || !['createEvent', 'recordAuthorizationDenied'].every((name) => typeof auditService[name] === 'function')) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');
  if (typeof idFactory !== 'function') throw new TypeError('ID_FACTORY_REQUIRED');

  async function recordDenied({ principal, tenantContext, correlationId }, operation) {
    if (!isInternalUuid(principal?.tenantId) || principal.tenantId !== tenantContext?.tenantId) return;
    await auditService.recordAuthorizationDenied({
      principal, tenantContext, correlationId, targetType: 'integration', targetId: 'catering-configuration',
      metadata: { operation },
    });
  }

  async function authorize({ principal, tenantContext, correlationId, integrationId }, operation, integrationRequired = true) {
    requireUuid(correlationId);
    if (integrationRequired) requireUuid(integrationId);
    try {
      authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_INTEGRATIONS_MANAGE);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) await recordDenied({ principal, tenantContext, correlationId }, operation);
      throw error;
    }
    if (!isTenantSessionAvailable(tenantContext)) throw new TenantUnavailableError();
    return { principal, tenantContext, correlationId: requireUuid(correlationId),
      integrationId: integrationRequired ? requireUuid(integrationId) : null };
  }

  function currentValue(value, tenantId, integrationId, expectedProviderId = null) {
    if (!value || value.tenantId !== tenantId || value.integrationId !== integrationId
      || (expectedProviderId !== null && value.providerId !== expectedProviderId)) {
      throw new TypeError('CATERING_CONFIGURATION_REPOSITORY_SCOPE_INVALID');
    }
    const descriptor = registry.get(value.providerId);
    if (descriptor.id !== value.providerId) throw new TypeError('CATERING_CONFIGURATION_REPOSITORY_SCOPE_INVALID');
    let configuration;
    let revision;
    try {
      configuration = configurationInput(value.configuration, descriptor);
      revision = requireTenantSettingsRevision(value.revision);
    } catch {
      throw new TypeError('CATERING_CONFIGURATION_REPOSITORY_RESULT_INVALID');
    }
    return Object.freeze({
      schemaVersion: 1, integrationId, providerId: descriptor.id,
      revision, configuration,
    });
  }

  async function load(tenantId, integrationId) {
    const result = await repository.loadCurrent({ tenantId, integrationId });
    if (result === null) throw unavailable();
    return currentValue(result, tenantId, integrationId);
  }

  return Object.freeze({
    async list({ afterIntegrationId = null, ...context }) {
      const authorized = await authorize(context, 'catering_configuration_list', false);
      if (typeof repository.listCurrent !== 'function' || typeof registry.list !== 'function') {
        throw new TypeError('CATERING_SETUP_REPOSITORY_REQUIRED');
      }
      const after = afterIntegrationId === null ? null : requireUuid(afterIntegrationId);
      const page = await repository.listCurrent({ tenantId: authorized.tenantContext.tenantId, afterIntegrationId: after });
      if (!page || !Array.isArray(page.items) || page.items.length > 20) throw new TypeError('CATERING_CONFIGURATION_PAGE_INVALID');
      const items = page.items.map((value) => currentValue(value, authorized.tenantContext.tenantId, requireUuid(value?.integrationId)));
      let previous = after;
      for (const item of items) {
        if (previous !== null && item.integrationId <= previous) throw new TypeError('CATERING_CONFIGURATION_PAGE_INVALID');
        previous = item.integrationId;
      }
      const next = page.nextAfterIntegrationId;
      if (next !== null && (items.length !== 20 || next !== items.at(-1).integrationId)) {
        throw new TypeError('CATERING_CONFIGURATION_PAGE_INVALID');
      }
      const providers = registry.list().filter((entry) => Object.keys(entry.capabilities).some((key) => key.startsWith('catering.')))
        .map((entry) => Object.freeze({ providerId: entry.id, capabilities: entry.capabilities }));
      return Object.freeze({ schemaVersion: 1, providers: Object.freeze(providers),
        connections: Object.freeze(items), nextAfterIntegrationId: next });
    },
    async create({ schemaVersion, commandId, providerId, configuration, ...context }) {
      const authorized = await authorize(context, 'catering_configuration_create', false);
      requireTenantSettingsSchemaVersion(schemaVersion);
      const command = requireUuid(commandId);
      if (typeof repository.create !== 'function') throw new TypeError('CATERING_SETUP_REPOSITORY_REQUIRED');
      let descriptor;
      try { descriptor = registry.get(providerId); } catch { throw new TenantSettingsInputError('CATERING_PROVIDER_INVALID'); }
      const proposed = configurationInput(configuration, descriptor);
      const { principal, tenantContext, correlationId } = authorized;
      if (!isInternalUuid(principal.session?.id) || !Number.isSafeInteger(principal.session?.securityVersion)
        || principal.session.securityVersion < 1) throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      const integrationId = requireUuid(idFactory());
      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0 || !Number.isFinite(new Date(changedMs).getTime())) {
        throw new TypeError('CATERING_CONFIGURATION_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const result = await repository.create({
        tenantId: tenantContext.tenantId, integrationId, providerId: descriptor.id, commandId: command,
        actorUserId: principal.userId, sessionId: principal.session.id, expectedSecurityVersion: principal.session.securityVersion,
        expectedRevision: 0, configuration: proposed, changedAt, correlationId,
        auditEventFor({ revision }) {
          if (revision !== 1) throw new TypeError('CATERING_CONFIGURATION_REVISION_INVALID');
          return auditService.createEvent({
            principal, tenantContext, correlationId, action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
            targetType: 'integration', targetId: integrationId, outcome: AUDIT_OUTCOME.SUCCESS,
            previousState: { revision: 0 }, newState: { revision: 1 },
            metadata: { operation: 'catering_configuration_create' }, retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: changedAt.toISOString(),
          });
        },
      });
      if (result?.status === 'not_authorized') {
        await recordDenied(authorized, 'catering_configuration_create');
        throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status !== 'updated' || result.current?.revision !== 1
        || (result.replayed !== true && result.current.integrationId !== integrationId)) {
        throw new TypeError('CATERING_CONFIGURATION_CREATE_RESULT_INVALID');
      }
      const saved = currentValue(result.current, tenantContext.tenantId, requireUuid(result.current.integrationId), descriptor.id);
      if (JSON.stringify(saved.configuration) !== JSON.stringify(proposed)) {
        throw new TypeError('CATERING_CONFIGURATION_CREATE_RESULT_INVALID');
      }
      return saved;
    },
    async current(context) {
      const authorized = await authorize(context, 'catering_configuration_read');
      return load(authorized.tenantContext.tenantId, authorized.integrationId);
    },
    async update({ schemaVersion, expectedRevision, configuration, ...context }) {
      const authorized = await authorize(context, 'catering_configuration_update');
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = requireTenantSettingsRevision(expectedRevision);
      const { principal, tenantContext, correlationId, integrationId } = authorized;
      if (!isInternalUuid(principal.session?.id) || !Number.isSafeInteger(principal.session?.securityVersion)
        || principal.session.securityVersion < 1) throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      const current = await load(tenantContext.tenantId, integrationId);
      if (current.revision !== expected) throw new TenantSettingsConflictError(current.revision);
      const nextRevision = nextTenantSettingsRevision(expected);
      const proposed = configurationInput(configuration, registry.get(current.providerId));
      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0 || !Number.isFinite(new Date(changedMs).getTime())) {
        throw new TypeError('CATERING_CONFIGURATION_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const result = await repository.update({
        tenantId: tenantContext.tenantId, integrationId, providerId: current.providerId,
        actorUserId: principal.userId, expectedRevision: expected, configuration: proposed, changedAt, correlationId,
        sessionId: principal.session.id, expectedSecurityVersion: principal.session.securityVersion,
        auditEventFor({ revision }) {
          if (revision !== nextRevision) throw new TypeError('CATERING_CONFIGURATION_REVISION_INVALID');
          return auditService.createEvent({
            principal, tenantContext, correlationId, action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED,
            targetType: 'integration', targetId: integrationId, outcome: AUDIT_OUTCOME.SUCCESS,
            previousState: { revision: expected }, newState: { revision: nextRevision },
            metadata: { operation: 'catering_configuration_update' },
            retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE, occurredAt: changedAt.toISOString(),
          });
        },
      });
      if (result?.status === 'not_authorized') {
        await recordDenied(authorized, 'catering_configuration_update');
        throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (result?.status === 'not_found') throw unavailable();
      if (result?.status === 'conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status !== 'updated' || result.current?.revision !== nextRevision) {
        throw new TypeError('CATERING_CONFIGURATION_UPDATE_RESULT_INVALID');
      }
      const saved = currentValue(result.current, tenantContext.tenantId, integrationId, current.providerId);
      if (JSON.stringify(saved.configuration) !== JSON.stringify(proposed)) {
        throw new TypeError('CATERING_CONFIGURATION_UPDATE_RESULT_INVALID');
      }
      return saved;
    },
  });
}
