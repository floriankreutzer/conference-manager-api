import { AUDIT_ACTION } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringProviderCatalogue, normalizeCateringProviderCatalogueMetadata,
  normalizeCateringProviderCatalogueReceiptCommand } from '../domain/catering-provider-catalogue.js';
import { normalizeCateringConfiguration } from '../integrations/catering-configuration.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringProviderCatalogueInputError, CateringProviderCatalogueConflictError } from './catering-provider-catalogue-errors.js';

function invalid() { throw new TypeError('CATERING_PROVIDER_CATALOGUE_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function count(value, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid(); return value;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function array(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
function reference(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.normalize('NFC')
    || value !== value.trim() || !value.length || value.length > 160
    || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) invalid(); return value;
}
function source(value, scope) {
  const normalized = normalizeCateringProviderCatalogue(value, scope);
  return Object.freeze({ schemaVersion: 1, sourceVersion: normalized.sourceVersion, items: normalized.items,
    packages: normalized.packages, terms: normalized.terms });
}
function input(work) { try { return work(); } catch { throw new CateringProviderCatalogueInputError(); } }

export function createCateringProviderCatalogueService({ repository, registry, authorizationPolicy, auditService,
  maxResponseBytes = 262144 } = {}) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024
    || !repository || !['listConnections','load','loadRevision','receive'].every((key) => typeof repository[key] === 'function')
    || typeof registry?.get !== 'function' || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService?.[key] === 'function')) {
    throw new TypeError('CATERING_PROVIDER_CATALOGUE_PORT_REQUIRED');
  }
  async function denied(context, operation) {
    if (isInternalUuid(context?.principal?.tenantId) && context.principal.tenantId === context?.tenantContext?.tenantId) {
      await auditService.recordAuthorizationDenied({ ...context, targetType: 'integration', targetId: 'catering-provider-catalogue',
        metadata: { operation } });
    }
  }
  async function authorize(context, operation, integrationRequired = true) {
    uuid(context?.correlationId);
    try { authorizationPolicy.requireTenantPermission(context?.principal, context?.tenantContext, PERMISSION.TENANT_CATALOGUE_MANAGE); }
    catch (error) { if (error instanceof AuthorizationDeniedError) await denied(context, operation); throw error; }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    return { principal: context.principal, tenantContext: context.tenantContext, tenantId: uuid(context.tenantContext.tenantId),
      actorUserId: uuid(context.principal.userId), correlationId: uuid(context.correlationId),
      integrationId: integrationRequired ? input(() => uuid(context.integrationId)) : null };
  }
  return Object.freeze({
    async listConnections(context) {
      const authorized = await authorize(context, 'catering_provider_catalogue_connections', false);
      const after = input(() => context.afterIntegrationId == null ? null : uuid(context.afterIntegrationId));
      const rows = await repository.listConnections({ tenantId: authorized.tenantId, afterIntegrationId: after });
      let previous = after;
      const connections = array(rows,21).map((entry) => {
        record(entry, ['tenantId','integrationId','providerId','configurationRevision','configuration',
          'connectionAvailable','currentRevision']);
        const integrationId = uuid(entry.integrationId);
        if (entry.tenantId !== authorized.tenantId || (previous !== null && integrationId <= previous)
          || typeof entry.connectionAvailable !== 'boolean') invalid();
        previous = integrationId;
        let configuration;
        try { configuration = normalizeCateringConfiguration(entry.configuration,registry.get(entry.providerId)); } catch { invalid(); }
        if (configuration.providerId !== entry.providerId) invalid();
        const currentRevision = count(entry.currentRevision,0);
        if (configuration.capabilities['catering.catalogue'] === 'unsupported' && currentRevision === 0) invalid();
        return Object.freeze({ integrationId,providerId: entry.providerId,configurationRevision: count(entry.configurationRevision),
          currentRevision,canReceive: entry.connectionAvailable && configuration.capabilities['catering.catalogue'] === 'manual' });
      });
      return Object.freeze({ schemaVersion: 1,connections: Object.freeze(connections.slice(0,20)),
        nextAfterIntegrationId: connections.length > 20 ? connections[19].integrationId : null });
    },
    async load(context) {
      const authorized = await authorize(context, 'catering_provider_catalogue_read');
      const beforeRevision = input(() => context.beforeRevision == null ? null : count(context.beforeRevision));
      const value = await repository.load({ tenantId: authorized.tenantId, integrationId: authorized.integrationId, beforeRevision });
      if (value === null) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','integrationId','providerId','configurationRevision','configuration','connectionAvailable',
        'currentRevision','revisions','nextBeforeRevision']);
      if (value.tenantId !== authorized.tenantId || value.integrationId !== authorized.integrationId
        || typeof value.connectionAvailable !== 'boolean') invalid();
      const configurationRevision = count(value.configurationRevision); const currentRevision = count(value.currentRevision, 0);
      let configuration;
      try { configuration = normalizeCateringConfiguration(value.configuration, registry.get(value.providerId)); } catch { invalid(); }
      if (configuration.providerId !== value.providerId) invalid();
      let upper = Math.min(beforeRevision ?? currentRevision + 1, currentRevision + 1);
      const expectedCount = Math.min(20, upper - 1);
      const revisions = array(value.revisions, 20).map((entry) => {
        record(entry, ['revision','configurationRevision','recordedAt','reference','summary']);
        const revision = count(entry.revision);
        if (revision !== upper - 1 || revision > currentRevision || count(entry.configurationRevision) > configurationRevision) invalid();
        upper = revision;
        return Object.freeze({ revision, configurationRevision: entry.configurationRevision,
          recordedAt: instant(entry.recordedAt), reference: reference(entry.reference),
          summary: normalizeCateringProviderCatalogueMetadata(entry.summary) });
      });
      const next = value.nextBeforeRevision === null ? null : count(value.nextBeforeRevision);
      const expectedNext = revisions.length > 0 && revisions.at(-1).revision > 1 ? revisions.at(-1).revision : null;
      if (revisions.length !== expectedCount || next !== expectedNext) invalid();
      return Object.freeze({ schemaVersion: 1, integrationId: authorized.integrationId, providerId: value.providerId,
        configurationRevision, currentRevision,
        canReceive: value.connectionAvailable && configuration.capabilities['catering.catalogue'] === 'manual',
        revisions: Object.freeze(revisions), nextBeforeRevision: next });
    },
    async loadRevision(context) {
      const authorized = await authorize(context, 'catering_provider_catalogue_detail');
      const parameters = input(() => {
        const revision = count(context.revision); const section = context.section ?? 'items';
        const afterEntryId = context.afterEntryId ?? null;
        if (!['items','packages'].includes(section) || (afterEntryId !== null
          && (typeof afterEntryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(afterEntryId)))) invalid();
        return { revision, section, afterEntryId };
      });
      const value = await repository.loadRevision({ tenantId: authorized.tenantId,
        integrationId: authorized.integrationId, revision: parameters.revision });
      if (value === null) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      record(value, ['tenantId','integrationId','providerId','commandId','revision','configurationRevision',
        'reference','recordedAt','actorUserId','actorSecurityVersion','source']);
      if (value.tenantId !== authorized.tenantId || value.integrationId !== authorized.integrationId
        || value.revision !== parameters.revision) invalid();
      let provider; try { provider = registry.get(value.providerId); } catch { invalid(); }
      if (provider.id !== value.providerId) invalid();
      const document = source(value.source, { tenantId: authorized.tenantId, integrationId: authorized.integrationId });
      const all = document[parameters.section].filter((entry) => parameters.afterEntryId === null || entry.id > parameters.afterEntryId);
      const base = { schemaVersion: 1, integrationId: authorized.integrationId, providerId: value.providerId,
        revision: value.revision, configurationRevision: count(value.configurationRevision), recordedAt: instant(value.recordedAt),
        reference: reference(value.reference), sourceVersion: document.sourceVersion, terms: document.terms,
        itemCount: document.items.length, packageCount: document.packages.length, section: parameters.section };
      const entries = [];
      for (const entry of all.slice(0,5)) {
        const proposed = [...entries,entry];
        const nextAfterEntryId = proposed.length < all.length ? entry.id : null;
        const bytes = new TextEncoder().encode(JSON.stringify({ ...base, entries: proposed, nextAfterEntryId })).byteLength;
        if (bytes > Math.min(maxResponseBytes,524288)) {
          if (entries.length === 0) throw new TypeError('CATERING_PROVIDER_CATALOGUE_RESPONSE_TOO_LARGE');
          break;
        }
        entries.push(entry);
      }
      const nextAfterEntryId = entries.length < all.length ? entries.at(-1)?.id ?? null : null;
      const output = Object.freeze({ ...base, entries: Object.freeze(entries), nextAfterEntryId });
      if (new TextEncoder().encode(JSON.stringify(output)).byteLength > Math.min(maxResponseBytes,524288)) {
        throw new TypeError('CATERING_PROVIDER_CATALOGUE_RESPONSE_TOO_LARGE');
      }
      return output;
    },
    async receive(context) {
      const authorized = await authorize(context, 'catering_provider_catalogue_receive');
      const session = authorized.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      const scope = { tenantId: authorized.tenantId, integrationId: authorized.integrationId };
      const command = input(() => normalizeCateringProviderCatalogueReceiptCommand(context.command, scope));
      const saved = await repository.receive({ ...authorized, command, sessionId: uuid(session.id),
        expectedSecurityVersion: session.securityVersion, auditEventFor(values) {
          record(values, ['revision','configurationRevision']);
          if (values.revision !== command.expectedRevision + 1
            || values.configurationRevision !== command.expectedConfigurationRevision) invalid();
          return auditService.createEvent({ ...authorized, action: AUDIT_ACTION.CATERING_CATALOGUE_RECEIVED,
            targetType: 'integration', targetId: authorized.integrationId, outcome: 'success', retentionClass: 'business',
            previousState: { revision: command.expectedRevision }, newState: {
              revision: values.revision, configurationRevision: values.configurationRevision },
            metadata: { operation: 'catering_provider_catalogue_receive', source: 'manual',
              itemCount: command.source.items.length, packageCount: command.source.packages.length } });
        } });
      const status = saved && typeof saved === 'object' ? Object.getOwnPropertyDescriptor(saved, 'status') : null;
      if (!status?.enumerable || !Object.hasOwn(status, 'value')) invalid();
      record(saved, status.value === 'recorded' ? ['status','replayed','receipt'] : ['status']);
      if (saved.status === 'not_authorized') {
        await denied(authorized, 'catering_provider_catalogue_receive'); throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved?.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      const conflicts = { conflict: 'REVISION_CONFLICT', configuration_conflict: 'CONFIGURATION_CONFLICT',
        command_conflict: 'COMMAND_CONFLICT', source_unavailable: 'SOURCE_UNAVAILABLE' };
      if (Object.hasOwn(conflicts, saved?.status)) {
        throw new CateringProviderCatalogueConflictError(`CATERING_PROVIDER_CATALOGUE_${conflicts[saved.status]}`);
      }
      if (saved.status !== 'recorded' || typeof saved.replayed !== 'boolean') invalid();
      const receipt = saved.receipt;
      record(receipt, ['tenantId','integrationId','providerId','commandId','revision','configurationRevision',
        'reference','recordedAt','actorUserId','actorSecurityVersion','source']);
      let provider;
      try { provider = registry.get(receipt.providerId); } catch { invalid(); }
      if (provider.id !== receipt.providerId || receipt.tenantId !== authorized.tenantId
        || receipt.integrationId !== authorized.integrationId || receipt.commandId !== command.commandId
        || receipt.revision !== command.expectedRevision + 1 || receipt.configurationRevision !== command.expectedConfigurationRevision
        || receipt.actorUserId !== authorized.actorUserId || receipt.actorSecurityVersion !== session.securityVersion
        || receipt.reference !== command.reference
        || JSON.stringify(source(receipt.source, scope)) !== JSON.stringify(command.source)) invalid();
      return Object.freeze({ schemaVersion: 1, commandId: command.commandId, replayed: saved.replayed,
        revision: receipt.revision, configurationRevision: receipt.configurationRevision, recordedAt: instant(receipt.recordedAt) });
    },
  });
}
