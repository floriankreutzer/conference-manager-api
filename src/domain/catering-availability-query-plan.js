import { isInternalUuid } from './identifiers.js';
import { normalizeRequest } from './request.js';
import { normalizeCateringCataloguePublicationBindings } from './catering-catalogue-publication.js';
import { createCateringRequestCommercialSelection } from './catering-request-commercial-selection.js';
import { normalizeCateringAvailabilityQuery } from './catering-availability.js';
import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';

function invalid() { throw new TypeError('CATERING_AVAILABILITY_QUERY_PLAN_INVALID'); }
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

// Private, pure projection. Captured ownership/catalogue/publication/source
// evidence must be independently loaded and revalidated under the transaction's
// current authority fences. Matching identifiers alone prove no source provenance.
// This is not an authorization, current-publication or availability decision.
export function createCateringAvailabilityQueryPlan({request:requestValue,canonicalCatalogue,ownership,connections,
  providers,queryIdFactory,positionIdFactory}={}) {
  if (typeof queryIdFactory !== 'function' || typeof positionIdFactory !== 'function') invalid();
  const request=normalizeRequest(requestValue);
  const selection=createCateringRequestCommercialSelection({request,canonicalCatalogue,ownership,connections});
  const sources=new Map();
  for (const provider of array(providers)) {
    record(provider,['tenantId','integrationId','configurationRevision','publicationRevision','sourceRevision','sourceVersion','bindings']);
    const integrationId=uuid(provider.integrationId);
    if (uuid(provider.tenantId) !== request.tenantId || sources.has(integrationId)) invalid();
    const bindings=normalizeCateringCataloguePublicationBindings(provider.bindings,canonicalCatalogue);
    sources.set(integrationId,{...provider,integrationId,bindings});
  }
  if (sources.size !== selection.length || selection.some(({integrationId})=>!sources.has(integrationId))) invalid();
  const identities=new Set();
  function allocate(factory,context) {
    const identity=uuid(factory(Object.freeze(context))); if (identities.has(identity)) invalid();
    identities.add(identity); return identity;
  }
  return Object.freeze(selection.map(({integrationId,positions})=>{
    const source=sources.get(integrationId);
    const context={tenantId:request.tenantId,integrationId,requestId:request.id,requestVersion:request.version};
    const queryId=allocate(queryIdFactory,context);
    const selected=positions.map(position=>{
      const binding=source.bindings.find(value=>value.kind === position.kind && value.entryId === position.entryId);
      if (!binding) invalid();
      const variantId=position.kind === 'package'
        ? binding.variants.find(value=>value.entryId === position.packageDetails.variant.id)?.sourceId : null;
      if (position.kind === 'package' && (!variantId || position.packageDetails.includedItems.some(item=>
        !source.bindings.some(value=>value.kind === 'item' && value.entryId === item.id)))) invalid();
      return {positionId:allocate(positionIdFactory,{...context,kind:position.kind,entryId:position.entryId}),
        kind:position.kind,sourceId:binding.sourceId,variantId,quantity:position.quantity};
    });
    return normalizeCateringAvailabilityQuery({schemaVersion:1,queryId,configurationRevision:source.configurationRevision,
      publicationRevision:source.publicationRevision,sourceRevision:source.sourceRevision,sourceVersion:source.sourceVersion,
      siteId:request.snapshot.pricing.room.siteId,roomId:request.roomId,startsAt:request.startsAt,endsAt:request.endsAt,
      participantCount:request.snapshot.pricing.catering.participantCount,dietaryRequirements:request.snapshot.details.dietaryRequirements,
      specialRequirements:request.snapshot.details.specialRequirements,positions:selected},context);
  }));
}
