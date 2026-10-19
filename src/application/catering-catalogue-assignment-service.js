import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import {
  CateringCatalogueAssignmentError, cateringCatalogueAssignmentConnectionIds, normalizeCateringCatalogueAssignments,
} from '../domain/catering-catalogue-assignments.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { TenantSettingsConflictError, TenantSettingsInputError } from './tenant-settings-errors.js';
import { requireTenantSettingsRevision, requireTenantSettingsSchemaVersion } from './tenant-settings-revision.js';

import { CateringCatalogueAssignmentConflictError } from './catering-catalogue-assignment-errors.js';

const TARGET = 'catering_catalogue_assignments';
function input(code = 'CATERING_CATALOGUE_ASSIGNMENT_INPUT_INVALID') { return new TenantSettingsInputError(code); }
function uuid(value) {
  if (!isInternalUuid(value)) throw input();
  return value.toLowerCase();
}
function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER - 1) throw input();
  return value;
}
function resultRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
}
function publicCurrent(value, tenantId) {
  resultRecord(value, ['tenantId', 'revision', 'currentCatalogueRevision', 'assignedCatalogueRevision', 'assignments', 'stale']);
  if (value.tenantId !== tenantId || typeof value.stale !== 'boolean') throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
  const revision = value.revision;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
  }
  const current = requireTenantSettingsRevision(value.currentCatalogueRevision);
  const assigned = value.assignedCatalogueRevision;
  if ((revision === 0 && (assigned !== null || value.assignments.length !== 0 || !value.stale))
    || (revision > 0 && (!Number.isSafeInteger(assigned) || assigned < 1 || assigned > current))) {
    throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
  }
  cateringCatalogueAssignmentConnectionIds({ schemaVersion: 1, catalogueRevision: assigned ?? current, assignments: value.assignments });
  const assignments = value.assignments.map((entry) => Object.freeze({
    kind: entry.kind, entryId: entry.entryId, integrationId: uuid(entry.integrationId),
  }));
  if (new Set(assignments.map((entry) => `${entry.kind}:${entry.entryId}`)).size !== assignments.length) {
    throw new TypeError('CATERING_ASSIGNMENT_RESULT_INVALID');
  }
  return Object.freeze({ schemaVersion: 1, revision, currentCatalogueRevision: current, assignedCatalogueRevision: assigned,
    assignments: Object.freeze(assignments), stale: value.stale || assigned !== current });
}

export function createCateringCatalogueAssignmentService({ repository, authorizationPolicy, auditService, clock = Date.now } = {}) {
  if (!repository || !['loadCurrent', 'loadProposalInputs', 'listConnections', 'replace']
    .every((name) => typeof repository[name] === 'function')) throw new TypeError('CATERING_ASSIGNMENT_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function') {
    throw new TypeError('AUTHORIZATION_POLICY_REQUIRED');
  }
  if (!auditService || !['createEvent', 'recordAuthorizationDenied'].every((name) => typeof auditService[name] === 'function')) {
    throw new TypeError('AUDIT_SERVICE_REQUIRED');
  }
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');
  async function deny(context, operation) {
    if (!isInternalUuid(context?.principal?.tenantId) || context.principal.tenantId !== context.tenantContext?.tenantId) return;
    await auditService.recordAuthorizationDenied({ ...context, targetType: 'tenant_configuration', targetId: TARGET,
      metadata: { operation } });
  }
  async function authorize(context, operation) {
    uuid(context?.correlationId);
    try {
      authorizationPolicy.requireTenantPermission(context?.principal, context?.tenantContext, PERMISSION.TENANT_CATALOGUE_MANAGE);
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) await deny(context, operation);
      throw error;
    }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    return { principal: context.principal, tenantContext: context.tenantContext, correlationId: uuid(context.correlationId) };
  }
  function safeInput(work) {
    try { return work(); }
    catch (error) {
      if (error instanceof CateringCatalogueAssignmentError) throw input(error.code);
      throw error;
    }
  }
  return Object.freeze({
    async current(context) {
      const authorized = await authorize(context, 'catering_catalogue_assignment_read');
      const state = await repository.loadCurrent({ tenantId: authorized.tenantContext.tenantId });
      if (!state) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      return publicCurrent(state, authorized.tenantContext.tenantId);
    },
    async listConnections({ afterIntegrationId = null, ...context }) {
      const authorized = await authorize(context, 'catering_catalogue_connection_list');
      const after = afterIntegrationId === null ? null : uuid(afterIntegrationId);
      const page = await repository.listConnections({ tenantId: authorized.tenantContext.tenantId, afterIntegrationId: after });
      resultRecord(page, ['items', 'nextAfterIntegrationId']);
      if (!Array.isArray(page.items) || page.items.length > 20) throw new TypeError('CATERING_ASSIGNMENT_PAGE_INVALID');
      let previous = after;
      const connections = Array.from(page.items, (entry) => {
        resultRecord(entry, ['integrationId', 'providerId']);
        const integrationId = uuid(entry.integrationId);
        if ((previous !== null && integrationId <= previous) || typeof entry.providerId !== 'string'
          || !/^[a-z][a-z0-9_]{1,47}$/.test(entry.providerId)) throw new TypeError('CATERING_ASSIGNMENT_PAGE_INVALID');
        previous = integrationId;
        return Object.freeze({ integrationId, providerId: entry.providerId });
      });
      const next = page.nextAfterIntegrationId;
      if (next !== null && (connections.length !== 20 || next !== connections.at(-1).integrationId)) {
        throw new TypeError('CATERING_ASSIGNMENT_PAGE_INVALID');
      }
      return Object.freeze({ schemaVersion: 1, connections: Object.freeze(connections), nextAfterIntegrationId: next });
    },
    async replace({ schemaVersion, expectedRevision: expectedValue, catalogueRevision, assignments, ...context }) {
      const authorized = await authorize(context, 'catering_catalogue_assignment_replace');
      requireTenantSettingsSchemaVersion(schemaVersion);
      const expected = expectedRevision(expectedValue);
      const proposal = { schemaVersion: 1, catalogueRevision, assignments };
      safeInput(() => cateringCatalogueAssignmentConnectionIds(proposal));
      const { principal, tenantContext, correlationId } = authorized;
      if (!isInternalUuid(principal.session?.id) || !Number.isSafeInteger(principal.session?.securityVersion)
        || principal.session.securityVersion < 1) throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      const inputs = await repository.loadProposalInputs({ tenantId: tenantContext.tenantId, proposal });
      if (!inputs || inputs.tenantId !== tenantContext.tenantId) throw new TypeError('CATERING_ASSIGNMENT_REPOSITORY_SCOPE_INVALID');
      if (inputs.catalogueRevision !== catalogueRevision) throw new TenantSettingsConflictError(inputs.catalogueRevision);
      const normalized = safeInput(() => normalizeCateringCatalogueAssignments(proposal, inputs));
      const changedMs = clock();
      if (!Number.isSafeInteger(changedMs) || changedMs < 0 || !Number.isFinite(new Date(changedMs).getTime())) {
        throw new TypeError('CATERING_ASSIGNMENT_CLOCK_INVALID');
      }
      const changedAt = new Date(changedMs);
      const next = expected + 1;
      const result = await repository.replace({
        tenantId: tenantContext.tenantId, actorUserId: principal.userId, sessionId: principal.session.id,
        expectedSecurityVersion: principal.session.securityVersion, expectedRevision: expected,
        proposal: { schemaVersion: 1, catalogueRevision: normalized.catalogueRevision, assignments: normalized.assignments },
        changedAt, correlationId,
        auditEventFor({ revision, catalogueRevision: actualCatalogueRevision }) {
          if (revision !== next || actualCatalogueRevision !== catalogueRevision) {
            throw new TypeError('CATERING_ASSIGNMENT_REVISION_INVALID');
          }
          return auditService.createEvent({ principal, tenantContext, correlationId,
            action: AUDIT_ACTION.TENANT_CONFIGURATION_CHANGED, targetType: 'tenant_configuration', targetId: TARGET,
            outcome: AUDIT_OUTCOME.SUCCESS, previousState: { revision: expected }, newState: { revision: next, catalogueRevision },
            metadata: { operation: 'catering_catalogue_assignment_replace' }, retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
            occurredAt: changedAt.toISOString() });
        },
      });
      if (result?.status === 'not_authorized') {
        await deny(authorized, 'catering_catalogue_assignment_replace');
        throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (result?.status === 'conflict') throw new CateringCatalogueAssignmentConflictError(result.currentRevision);
      if (result?.status === 'catalogue_conflict') throw new TenantSettingsConflictError(result.currentRevision);
      if (result?.status !== 'updated') throw new TypeError('CATERING_ASSIGNMENT_WRITE_RESULT_INVALID');
      const saved = publicCurrent(result.current, tenantContext.tenantId);
      if (saved.revision !== next || saved.assignedCatalogueRevision !== catalogueRevision || saved.stale
        || JSON.stringify(saved.assignments) !== JSON.stringify(normalized.assignments)) {
        throw new TypeError('CATERING_ASSIGNMENT_WRITE_RESULT_INVALID');
      }
      return saved;
    },
  });
}
