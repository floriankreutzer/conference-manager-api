import { createHash } from 'node:crypto';
import { isInternalUuid } from './identifiers.js';
import { normalizeRequest } from './request.js';
import { normalizeCateringCataloguePublicationBindings } from './catering-catalogue-publication.js';
import { createCateringRequestCommercialSelection,createCateringRequestCommercialSelectionAtCatalogue
} from './catering-request-commercial-selection.js';
import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

function invalid() { throw new TypeError('CATERING_REQUEST_SOURCE_EVIDENCE_INVALID'); }
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key=>{
    const property=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property,'value');
  })) invalid();
}
function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length>CATERING_MAX_ORDER_POSITIONS
    || Reflect.ownKeys(value).length !== value.length+1) invalid();
  for (let n=0;n<value.length;n++) {
    const property=Object.getOwnPropertyDescriptor(value,String(n));
    if (!property?.enumerable || !Object.hasOwn(property,'value')) invalid();
  }
  return value;
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value<1 || value>=Number.MAX_SAFE_INTEGER) invalid(); return value; }
function selectionFor(input) {
  const request=normalizeRequest(input.request); if (request.snapshot === null) invalid();
  const catering=request.snapshot.details.catering;
  if (catering.packageSelection === null && catering.itemQuantities.length === 0) return [];
  return createCateringRequestCommercialSelection({...input,request});
}
function version(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed() || value !== value.trim().normalize('NFC') || !value.length || value.length>160
    || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) invalid();
  return value;
}
const key=value=>`${value.kind}:${value.entryId}`;
const compare=(a,b)=>key(a)<key(b) ? -1 : key(a)>key(b) ? 1 : 0;
function fingerprint(request,selection) {
  return createHash('sha256').update(JSON.stringify({tenantId:request.tenantId,requestId:request.id,
    startsAt:request.startsAt,endsAt:request.endsAt,roomId:request.roomId,siteId:request.snapshot.pricing.room.siteId,
    participantCount:request.snapshot.pricing.catering.participantCount,
    dietaryRequirements:request.snapshot.details.dietaryRequirements,specialRequirements:request.snapshot.details.specialRequirements,
    providers:selection.map(({integrationId,positions})=>({integrationId,positions:[...positions].sort(compare)}))})).digest('hex');
}
function selectedBindings(source,positions,canonicalCatalogue) {
  const bindings=normalizeCateringCataloguePublicationBindings(source,canonicalCatalogue); const selected=new Map();
  function include(kind,entryId,variantId=null) {
    const binding=bindings.find(value=>value.kind === kind && value.entryId === entryId); if (!binding) invalid();
    const variants=variantId === null ? [] : binding.variants.filter(value=>value.entryId === variantId);
    if (variantId !== null && variants.length !== 1) invalid();
    selected.set(key(binding),Object.freeze({...binding,variants:Object.freeze(variants)}));
  }
  for (const position of positions) {
    include(position.kind,position.entryId,position.kind === 'package' ? position.packageDetails.variant.id : null);
    for (const item of position.packageDetails?.includedItems ?? []) include('item',item.id);
  }
  return Object.freeze([...selected.values()].sort(compare));
}

function providersFor(request,selection,publications,canonicalCatalogue) {
  const metadata=new Map();
  for (const publication of array(publications)) {
    record(publication,['tenantId','integrationId','configurationRevision','reviewRevision','publicationRevision',
      'sourceRevision','sourceVersion','bindings']);
    const integrationId=uuid(publication.integrationId);
    if (uuid(publication.tenantId) !== request.tenantId || metadata.has(integrationId)) invalid();
    for (const field of ['configurationRevision','reviewRevision','publicationRevision','sourceRevision']) revision(publication[field]);
    version(publication.sourceVersion); metadata.set(integrationId,publication);
  }
  if (metadata.size !== selection.length || selection.some(value=>!metadata.has(value.integrationId))) invalid();
  return Object.freeze(selection.map(({integrationId,positions})=>{
    const source=metadata.get(integrationId);
    return Object.freeze({integrationId,configurationRevision:source.configurationRevision,reviewRevision:source.reviewRevision,
      publicationRevision:source.publicationRevision,sourceRevision:source.sourceRevision,sourceVersion:source.sourceVersion,
      bindings:selectedBindings(source.bindings,positions,canonicalCatalogue)});
  }));
}

// Capture only from independently loaded same-transaction Request, exact
// assignment and immutable publication/source references. This positive value
// schema cannot prove those database references exist or authenticate an actor.
export function createCateringRequestSourceEvidence({request:requestValue,assignmentRevision,
  canonicalCatalogue,ownership,connections,publications}={}) {
  const request=normalizeRequest(requestValue);
  const selection=selectionFor({request,canonicalCatalogue,ownership,connections});
  if (assignmentRevision !== 0 || selection.length>0) revision(assignmentRevision);
  const providers=providersFor(request,selection,publications,canonicalCatalogue);
  return Object.freeze({schemaVersion:1,tenantId:request.tenantId,requestId:request.id,requestVersion:request.version,
    originRequestVersion:request.version,catalogueRevision:request.snapshot.configurationRevisions.catalogue,assignmentRevision,
    intentFingerprint:fingerprint(request,selection),providers:Object.freeze(providers)});
}

// The actual origin Request revision must be loaded by its immutable FK. A
// later status revision retains origin and business intent; time proximity or
// a matching current product ID never supplies missing historic provenance.
export function normalizeCateringRequestSourceEvidence(value,{request:requestValue,originRequest:originValue,
  canonicalCatalogue,ownership,connections}={}) {
  record(value,['schemaVersion','tenantId','requestId','requestVersion','originRequestVersion','catalogueRevision',
    'assignmentRevision','intentFingerprint','providers']);
  if (value.schemaVersion !== 1) invalid();
  const request=normalizeRequest(requestValue); const origin=normalizeRequest(originValue);
  if (uuid(value.tenantId) !== request.tenantId || origin.tenantId !== request.tenantId || value.requestId !== request.id
    || origin.id !== request.id || revision(value.requestVersion) !== request.version
    || revision(value.originRequestVersion) !== origin.version || origin.version>request.version
    || revision(value.catalogueRevision) !== origin.snapshot?.configurationRevisions.catalogue) invalid();
  const publications=array(value.providers).map(provider=>{
    record(provider,['integrationId','configurationRevision','reviewRevision','publicationRevision',
      'sourceRevision','sourceVersion','bindings']);
    return {tenantId:request.tenantId,...provider};
  });
  const normalizedProviders=publications.map(source=>({integrationId:uuid(source.integrationId),
    configurationRevision:source.configurationRevision,reviewRevision:source.reviewRevision,publicationRevision:source.publicationRevision,
    sourceRevision:source.sourceRevision,sourceVersion:source.sourceVersion,
    bindings:[...normalizeCateringCataloguePublicationBindings(source.bindings,canonicalCatalogue)].sort(compare)}))
    .sort((a,b)=>a.integrationId<b.integrationId ? -1 : a.integrationId>b.integrationId ? 1 : 0);
  const captured=createCateringRequestSourceEvidence({request:origin,assignmentRevision:value.assignmentRevision,
    canonicalCatalogue,ownership,connections,publications});
  const selection=selectionFor({request,canonicalCatalogue,ownership,connections});
  if (request.snapshot.configurationRevisions.catalogue !== captured.catalogueRevision
    || value.intentFingerprint !== captured.intentFingerprint || fingerprint(request,selection) !== captured.intentFingerprint
    || JSON.stringify(normalizedProviders) !== JSON.stringify(captured.providers)) invalid();
  return Object.freeze({...captured,requestVersion:request.version});
}

export function carryCateringRequestSourceEvidence(value,{previousRequest,request:requestValue,...source}={}) {
  const normalized=normalizeCateringRequestSourceEvidence(value,{request:previousRequest,...source});
  const request=normalizeRequest(requestValue);
  if (request.version !== normalized.requestVersion+1) invalid();
  return normalizeCateringRequestSourceEvidence({...normalized,requestVersion:request.version},{request,...source});
}

// Necessary current semantic/source revalidation only. Immutable captured source
// records remain unchanged. Live authorization, configuration capability, actual
// current publication FKs and lock consistency are independent repository duties.
export function revalidateCateringRequestSourceForAvailability(value,{request:requestValue,originRequest,
  canonicalCatalogue,ownership,connections,currentCatalogue,currentCatalogueRevision,currentOwnership,
  currentConnections,currentPublications}={}) {
  const request=normalizeRequest(requestValue); const currentRevision=revision(currentCatalogueRevision);
  const captured=normalizeCateringRequestSourceEvidence(value,{request,originRequest,canonicalCatalogue,ownership,connections});
  const catering=request.snapshot.details.catering;
  const selection=catering.packageSelection === null && catering.itemQuantities.length === 0 ? []
    : createCateringRequestCommercialSelectionAtCatalogue({request,canonicalCatalogue:currentCatalogue,
      ownership:currentOwnership,connections:currentConnections},currentRevision);
  if (fingerprint(request,selection) !== captured.intentFingerprint) invalid();
  const providers=providersFor(request,selection,currentPublications,currentCatalogue);
  if (providers.length !== captured.providers.length || providers.some((provider,index)=>{
    const original=captured.providers[index];
    return provider.integrationId !== original.integrationId || JSON.stringify(provider.bindings) !== JSON.stringify(original.bindings);
  })) invalid();
  return Object.freeze(providers.map(provider=>Object.freeze({tenantId:request.tenantId,integrationId:provider.integrationId,
    configurationRevision:provider.configurationRevision,publicationRevision:provider.publicationRevision,
    sourceRevision:provider.sourceRevision,sourceVersion:provider.sourceVersion,bindings:provider.bindings})));
}
