import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringCatalogueReviewCommand,planCateringCataloguePublication } from '../domain/catering-catalogue-publication.js';
import { tenantCatalogueSummary } from '../domain/tenant-catalogue.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringCataloguePublicationInputError,
  CateringCataloguePublicationConflictError } from './catering-catalogue-publication-errors.js';

function invalid() { throw new TypeError('CATERING_CATALOGUE_PUBLICATION_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function counter(value,minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid(); return value;
}
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  })) invalid();
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
function publicationIntent(command) {
  return { schemaVersion: 1,commandId: command.commandId,expectedSourceRevision: command.expectedSourceRevision,
    expectedConfigurationRevision: command.expectedConfigurationRevision,expectedCatalogueRevision: command.expectedCatalogueRevision,
    expectedAssignmentRevision: command.expectedAssignmentRevision,expectedPublicationRevision: command.expectedPublicationRevision,
    items: command.items,packages: command.packages };
}

// Uncomposed until the repository provides one live-authority/command/CAS/
// catalogue/assignment/publication/audit transaction. No outbound effect port.
export function createCateringCataloguePublicationService({ repository,authorizationPolicy,auditService } = {}) {
  if (typeof repository?.review !== 'function' || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || !['createEvent','recordAuthorizationDenied'].every((key) => typeof auditService?.[key] === 'function')) {
    throw new TypeError('CATERING_CATALOGUE_PUBLICATION_PORT_REQUIRED');
  }
  return Object.freeze({
    async review(context) {
      uuid(context?.correlationId);
      try { authorizationPolicy.requireTenantPermission(context?.principal,context?.tenantContext,PERMISSION.TENANT_CATALOGUE_MANAGE); }
      catch (error) {
        if (error instanceof AuthorizationDeniedError && isInternalUuid(context?.principal?.tenantId)
          && context.principal.tenantId === context?.tenantContext?.tenantId) {
          await auditService.recordAuthorizationDenied({ ...context,targetType: 'integration',targetId: 'catering_catalogue_review',
            metadata: { operation: 'catering_catalogue_review' } });
        }
        throw error;
      }
      if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
      const scope = { tenantId: uuid(context.tenantContext.tenantId),integrationId: uuid(context.integrationId),
        actorUserId: uuid(context.principal.userId),correlationId: uuid(context.correlationId) };
      const session = context.principal.session;
      if (!isInternalUuid(session?.id) || !Number.isSafeInteger(session.securityVersion) || session.securityVersion < 1
        || session.securityVersion >= Number.MAX_SAFE_INTEGER) throw new AuthorizationDeniedError('SESSION_REQUIRED');
      let command;
      try { command = normalizeCateringCatalogueReviewCommand(context.command); }
      catch { throw new CateringCataloguePublicationInputError(); }
      const authority = { ...context,...scope }; const expectedReviewRevision = command.expectedReviewRevision;
      const saved = await repository.review({ ...scope,sessionId: uuid(session.id),expectedSecurityVersion: session.securityVersion,command,
        planFor(state) {
          record(state,['tenantId','integrationId','sourceRevision','configurationRevision','catalogueRevision',
            'assignmentRevision','publicationRevision','source','catalogue','assignments','connections','previousBindings']);
          if (state.tenantId !== scope.tenantId || state?.integrationId !== scope.integrationId) invalid();
          if (command.decision !== 'published') invalid();
          return planCateringCataloguePublication(publicationIntent(command),state);
        },
        catalogueAuditFor(value) {
          record(value,['previous','next','nextRevision']); const { previous,next,nextRevision } = value;
          if (command.decision !== 'published' || nextRevision !== command.expectedCatalogueRevision+1) invalid();
          const summary = tenantCatalogueSummary(next); tenantCatalogueSummary(previous);
          return auditService.createEvent({ ...authority,action: 'tenant.configuration.changed',targetType: 'catalogue',
            targetId: 'tenant-catalogue',outcome: 'success',retentionClass: 'administrative',
            previousState: { revision: command.expectedCatalogueRevision },newState: { revision: nextRevision },
            metadata: { operation: 'catering_catalogue_publication',...summary } });
        },
        assignmentAuditFor(value) {
          record(value,['revision','catalogueRevision']); const { revision,catalogueRevision } = value;
          if (command.decision !== 'published' || revision !== command.expectedAssignmentRevision+1
            || catalogueRevision !== command.expectedCatalogueRevision+1) invalid();
          return auditService.createEvent({ ...authority,action: 'tenant.configuration.changed',targetType: 'tenant_configuration',
            targetId: 'catering_catalogue_assignments',outcome: 'success',retentionClass: 'administrative',
            previousState: { revision: command.expectedAssignmentRevision },newState: { revision,catalogueRevision },
            metadata: { operation: 'catering_catalogue_assignment_replace' } });
        },
        reviewAuditFor(value) {
          record(value,['reviewRevision','publicationRevision','catalogueRevision','assignmentRevision']);
          const { reviewRevision,publicationRevision,catalogueRevision,assignmentRevision } = value;
          const increment = command.decision === 'published' ? 1 : 0;
          if (reviewRevision !== expectedReviewRevision+1 || publicationRevision !== command.expectedPublicationRevision+increment
            || catalogueRevision !== command.expectedCatalogueRevision+increment
            || assignmentRevision !== command.expectedAssignmentRevision+increment) invalid();
          return auditService.createEvent({ ...authority,action: `catering.catalogue.${command.decision}`,targetType: 'integration',
            targetId: scope.integrationId,outcome: 'success',retentionClass: 'business',
            previousState: { revision: expectedReviewRevision },newState: { revision: reviewRevision },
            metadata: { operation: 'catering_catalogue_review',sourceRevision: command.expectedSourceRevision,
              publicationRevision,catalogueRevision,assignmentRevision,decision: command.decision } });
        } });
      const discriminator = saved && typeof saved === 'object' ? Object.getOwnPropertyDescriptor(saved,'status') : null;
      if (!discriminator?.enumerable || !Object.hasOwn(discriminator,'value')) invalid();
      record(saved,discriminator.value === 'reviewed' ? ['status','replayed','receipt']
        : discriminator.value === 'conflict' ? ['status','kind'] : ['status']);
      if (saved.status === 'not_authorized') {
        await auditService.recordAuthorizationDenied({ ...authority,targetType: 'integration',targetId: scope.integrationId,
          metadata: { operation: 'catering_catalogue_review' } });
        throw new AuthorizationDeniedError('PRINCIPAL_NOT_AUTHORIZED');
      }
      if (saved.status === 'not_found') throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE',{ conceal: true });
      if (saved.status === 'conflict') throw new CateringCataloguePublicationConflictError(saved.kind);
      if (saved.status !== 'reviewed' || typeof saved.replayed !== 'boolean') invalid();
      const receipt = saved.receipt;
      record(receipt,['tenantId','integrationId','actorUserId','actorSecurityVersion','command','reviewRevision',
        'publicationRevision','catalogueRevision','assignmentRevision','recordedAt']);
      const increment = command.decision === 'published' ? 1 : 0;
      if (receipt.tenantId !== scope.tenantId || receipt.integrationId !== scope.integrationId
        || receipt.actorUserId !== scope.actorUserId || receipt.actorSecurityVersion !== session.securityVersion
        || JSON.stringify(normalizeCateringCatalogueReviewCommand(receipt.command)) !== JSON.stringify(command)
        || counter(receipt.reviewRevision) !== expectedReviewRevision+1
        || counter(receipt.publicationRevision,0) !== command.expectedPublicationRevision+increment
        || counter(receipt.catalogueRevision) !== command.expectedCatalogueRevision+increment
        || counter(receipt.assignmentRevision,0) !== command.expectedAssignmentRevision+increment) invalid();
      return Object.freeze({ schemaVersion: 1,commandId: command.commandId,replayed: saved.replayed,decision: command.decision,
        reviewRevision: receipt.reviewRevision,publicationRevision: receipt.publicationRevision,
        catalogueRevision: receipt.catalogueRevision,assignmentRevision: receipt.assignmentRevision,
        recordedAt: instant(receipt.recordedAt) });
    },
  });
}
