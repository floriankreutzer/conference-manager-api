import { AuthorizationDeniedError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeCateringConfiguration } from '../integrations/catering-configuration.js';
import { isTenantBusinessActive } from '../tenancy/tenant.js';
import { TenantUnavailableError } from '../tenancy/errors.js';
import { CateringCataloguePublicationInputError,
  CateringCataloguePublicationConflictError } from './catering-catalogue-publication-errors.js';

function invalid() { throw new TypeError('CATERING_CATALOGUE_REVIEW_READ_RESULT_INVALID'); }
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  })) invalid();
}
function count(value,minimum = 0) {
  if (!Number.isSafeInteger(value) || value<minimum || value>=Number.MAX_SAFE_INTEGER) invalid(); return value;
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(); return value; }
function array(value,limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length>limit
    || Reflect.ownKeys(value).length !== value.length+1) invalid();
  for (let i=0;i<value.length;i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value,String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) invalid();
  }
  return value;
}
function cursor(value) {
  record(value,['kind','entryId']); if (!['item','package'].includes(value.kind)) invalid();
  return Object.freeze({ kind: value.kind,entryId: identifier(value.entryId) });
}
function key(value) { return `${value.kind}:${value.entryId}`; }
function binding(value) {
  record(value,['kind','entryId','sourceId','variants']);
  if (!['item','package'].includes(value.kind)) invalid();
  const variants = array(value.variants,20).map((entry) => {
    record(entry,['entryId','sourceId']); return Object.freeze({ entryId: identifier(entry.entryId),sourceId: identifier(entry.sourceId) });
  });
  if ((value.kind === 'item' && variants.length>0) || new Set(variants.map((x) => x.entryId)).size !== variants.length
    || new Set(variants.map((x) => x.sourceId)).size !== variants.length) invalid();
  return Object.freeze({ kind: value.kind,entryId: identifier(value.entryId),sourceId: identifier(value.sourceId),
    variants: Object.freeze(variants) });
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
function historical(value) {
  record(value,['revision','sourceRevision','configurationRevision','catalogueRevision','assignmentRevision',
    'publicationRevision','decision','justification','recordedAt']);
  for (const field of ['revision','sourceRevision','configurationRevision','catalogueRevision']) count(value[field],1);
  count(value.assignmentRevision); count(value.publicationRevision);
  if (!['published','rejected'].includes(value.decision) || (value.decision === 'published' && value.publicationRevision === 0)
    || value.publicationRevision>value.revision
    || (value.revision === 1 && value.publicationRevision !== (value.decision === 'published' ? 1 : 0))
    || typeof value.justification !== 'string' || !value.justification.isWellFormed()
    || value.justification.length<1 || value.justification.length>1000 || value.justification.trim() !== value.justification
    || value.justification.normalize('NFC') !== value.justification
    || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value.justification)) invalid();
  return Object.freeze({ ...value,recordedAt: instant(value.recordedAt) });
}
function pack(entries,maximum,build) {
  const encoder = new TextEncoder();
  for (let length=entries.length;length>=0;length--) {
    if (length === 0 && entries.length>0) break;
    const value = build(Object.freeze(entries.slice(0,length)));
    if (encoder.encode(JSON.stringify(value)).byteLength<=maximum) return Object.freeze(value);
  }
  throw new TypeError('CATERING_CATALOGUE_REVIEW_RESPONSE_TOO_LARGE');
}
export function createCateringCataloguePublicationReadService({ repository,registry,authorizationPolicy,auditService,
  maxResponseBytes = 524288 } = {}) {
  if (!['loadContext','listHistory'].every((name) => typeof repository?.[name] === 'function')
    || typeof registry?.get !== 'function' || typeof authorizationPolicy?.requireTenantPermission !== 'function'
    || typeof auditService?.recordAuthorizationDenied !== 'function'
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes<1024) {
    throw new TypeError('CATERING_CATALOGUE_REVIEW_READ_PORT_REQUIRED');
  }
  async function authorize(context) {
    uuid(context?.correlationId);
    try { authorizationPolicy.requireTenantPermission(context?.principal,context?.tenantContext,PERMISSION.TENANT_CATALOGUE_MANAGE); }
    catch (error) {
      if (error instanceof AuthorizationDeniedError && isInternalUuid(context?.principal?.tenantId)
        && context.principal.tenantId === context?.tenantContext?.tenantId) {
        await auditService.recordAuthorizationDenied({ ...context,targetType: 'integration',targetId: 'catering_catalogue_review',
          metadata: { operation: 'catering_catalogue_review_read' } });
      }
      throw error;
    }
    if (!isTenantBusinessActive(context.tenantContext)) throw new TenantUnavailableError();
    return { tenantId: uuid(context.tenantContext.tenantId),integrationId: uuid(context.integrationId) };
  }
  function checkScope(value,scope) {
    if (value === null) throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE',{ conceal: true });
    if (value?.tenantId !== scope.tenantId || value?.integrationId !== scope.integrationId) invalid();
  }
  return Object.freeze({
    async loadContext(context) {
      const scope = await authorize(context); let afterBinding; let publicationRevision;
      try {
        afterBinding = context.afterBinding == null ? null : cursor(context.afterBinding);
        publicationRevision = context.publicationRevision == null ? null : count(context.publicationRevision);
        if (afterBinding !== null && publicationRevision === null) invalid();
      } catch { throw new CateringCataloguePublicationInputError(); }
      const value = await repository.loadContext({ ...scope,afterBinding });
      if (value === null) checkScope(value,scope);
      record(value,['tenantId','integrationId','providerId','configurationRevision','configuration','connectionAvailable',
        'sourceRevision','reviewRevision','publicationRevision','publishedSourceRevision','catalogueRevision','catalogueEmpty',
        'assignmentRevision','assignmentReady','bindings']); checkScope(value,scope);
      count(value.configurationRevision,1); count(value.catalogueRevision,1);
      for (const field of ['sourceRevision','reviewRevision','publicationRevision','publishedSourceRevision','assignmentRevision']) {
        count(value[field]);
      }
      for (const field of ['connectionAvailable','catalogueEmpty','assignmentReady']) if (typeof value[field] !== 'boolean') invalid();
      if (value.publicationRevision>value.reviewRevision || value.publishedSourceRevision>value.sourceRevision
        || (value.sourceRevision === 0 && value.reviewRevision !== 0)
        || ((value.publicationRevision === 0) !== (value.publishedSourceRevision === 0))) invalid();
      if (publicationRevision !== null && publicationRevision !== value.publicationRevision) {
        throw new CateringCataloguePublicationConflictError('publication');
      }
      const configuration = normalizeCateringConfiguration(value.configuration,registry.get(value.providerId));
      if (configuration.providerId !== value.providerId) invalid();
      const entries = array(value.bindings,6).map(binding); let previous = afterBinding === null ? '' : key(afterBinding);
      const sourceIds = new Set();
      for (const entry of entries) {
        const sourceKey = `${entry.kind}:${entry.sourceId}`;
        if (key(entry)<=previous || sourceIds.has(sourceKey)) invalid();
        previous=key(entry); sourceIds.add(sourceKey);
      }
      if (value.publicationRevision === 0 && entries.length !== 0) invalid();
      return pack(entries.slice(0,5),Math.min(maxResponseBytes,524288),(page) => ({
        schemaVersion: 1,integrationId: scope.integrationId,providerId: configuration.providerId,
        configurationRevision: value.configurationRevision,sourceRevision: value.sourceRevision,reviewRevision: value.reviewRevision,
        publicationRevision: value.publicationRevision,publishedSourceRevision: value.publishedSourceRevision,
        catalogueRevision: value.catalogueRevision,assignmentRevision: value.assignmentRevision,
        canReview: value.connectionAvailable && configuration.capabilities['catering.catalogue'] !== 'unsupported'
          && value.sourceRevision>0 && value.assignmentReady,
        bindings: page,nextAfterBinding: entries.length>page.length
          ? cursor({ kind: page.at(-1).kind,entryId: page.at(-1).entryId }) : null }));
    },
    async listHistory(context) {
      const scope = await authorize(context); let beforeRevision;
      try { beforeRevision = context.beforeRevision == null ? null : count(context.beforeRevision,1); }
      catch { throw new CateringCataloguePublicationInputError(); }
      const value = await repository.listHistory({ ...scope,beforeRevision });
      if (value === null) checkScope(value,scope);
      record(value,['tenantId','integrationId','reviewRevision','revisions']); checkScope(value,scope);
      const currentRevision = count(value.reviewRevision);
      if (beforeRevision !== null && beforeRevision>currentRevision+1) throw new CateringCataloguePublicationInputError();
      const revisions = array(value.revisions,21).map(historical);
      let expected = Math.min(currentRevision,beforeRevision === null ? currentRevision : beforeRevision-1);
      let newer = null;
      for (const entry of revisions) {
        if (entry.revision !== expected) invalid(); expected--;
        if (newer) {
          const increment = newer.decision === 'published' ? 1 : 0;
          if (newer.publicationRevision !== entry.publicationRevision+increment
            || newer.sourceRevision<entry.sourceRevision || newer.configurationRevision<entry.configurationRevision
            || newer.catalogueRevision<entry.catalogueRevision+increment
            || newer.assignmentRevision<entry.assignmentRevision+increment) invalid();
        }
        newer=entry;
      }
      if (revisions.length<21 && expected !== 0) invalid();
      return pack(revisions.slice(0,20),Math.min(maxResponseBytes,524288),(page) => ({
        schemaVersion: 1,integrationId: scope.integrationId,currentRevision,revisions: page,
        nextBeforeRevision: revisions.length>page.length ? page.at(-1).revision : null }));
    },
  });
}
