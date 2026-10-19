import { isInternalUuid } from './identifiers.js';
import { normalizeTenantCatalogue } from './tenant-catalogue.js';
import { normalizeCateringCataloguePublicationBindings } from './catering-catalogue-publication.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const key=(kind,id)=>`${kind}:${id}`;
function invalid() { throw new TypeError('CATERING_PUBLISHED_OFFER_EVIDENCE_INVALID'); }
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((name) => {
    const descriptor=Object.getOwnPropertyDescriptor(value,name);
    return !keys.includes(name) || !descriptor.enumerable || !Object.hasOwn(descriptor,'value');
  })) invalid();
}
function array(value,maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length>maximum
    || Reflect.ownKeys(value).length !== value.length+1) invalid();
  for (let i=0;i<value.length;i++) {
    const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) invalid();
  }
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value<1 || value>=Number.MAX_SAFE_INTEGER) invalid(); }
function content(value) {
  // Presentation order alone is not a price/content/package change. Variants
  // are checked individually so a new unpublished variant cannot hide approved ones.
  const { order: _order,variants: _variants,...meaningful }=value;
  return JSON.stringify(meaningful);
}
function unchanged(current,published) {
  return current?.active === true && published?.active === true && content(current) === content(published);
}

// Pure necessary eligibility only. Inputs are independently loaded private
// persistence evidence within the caller's authorization/snapshot or lock fence.
// This grants no availability, reservation, order, actor or session authority.
export function createCateringPublishedOfferIndex(publications,expected) {
  record(expected,['tenantId','catalogue','assignments']); const tenantId=uuid(expected.tenantId);
  const catalogue=normalizeTenantCatalogue(expected.catalogue); const owners=new Map();
  for (const assignment of array(expected.assignments,400)) {
    record(assignment,['kind','entryId','integrationId']); if (!['item','package'].includes(assignment.kind)) invalid();
    const identifier=key(assignment.kind,id(assignment.entryId)); if (owners.has(identifier)) invalid();
    owners.set(identifier,uuid(assignment.integrationId));
  }
  const observed=new Set(); const items=new Set(); const packages=new Map(); const prepared=[];
  for (const value of array(publications,400)) {
    record(value,['tenantId','integrationId','publicationRevision','catalogueRevision','sourceRevision',
      'connectionAvailable','catalogueEnabled','catalogue','bindings']);
    const integrationId=uuid(value.integrationId);
    if (uuid(value.tenantId) !== tenantId || observed.has(integrationId)
      || typeof value.connectionAvailable !== 'boolean' || typeof value.catalogueEnabled !== 'boolean') invalid();
    observed.add(integrationId); revision(value.publicationRevision); revision(value.catalogueRevision); revision(value.sourceRevision);
    const published=normalizeTenantCatalogue(value.catalogue);
    const bindings=normalizeCateringCataloguePublicationBindings(value.bindings,published);
    if (!value.connectionAvailable || !value.catalogueEnabled) continue;
    prepared.push({ integrationId,published,bindings });
  }
  for (const { integrationId,published,bindings } of prepared) {
    for (const binding of bindings.filter((value) => value.kind === 'item')) {
      if (owners.get(key('item',binding.entryId)) !== integrationId) continue;
      const current=catalogue.cateringItems.find((value) => value.id === binding.entryId);
      const previous=published.cateringItems.find((value) => value.id === binding.entryId);
      if (unchanged(current,previous)) items.add(binding.entryId);
    }
  }
  for (const { integrationId,published,bindings } of prepared) {
    const boundItems=new Set(bindings.filter((value) => value.kind === 'item').map((value) => value.entryId));
    for (const binding of bindings.filter((value) => value.kind === 'package')) {
      if (owners.get(key('package',binding.entryId)) !== integrationId) continue;
      const current=catalogue.cateringPackages.find((value) => value.id === binding.entryId);
      const previous=published.cateringPackages.find((value) => value.id === binding.entryId);
      if (!unchanged(current,previous) || current.itemIds.some((entryId) => !items.has(entryId)
        || !boundItems.has(entryId) || owners.get(key('item',entryId)) !== integrationId)) continue;
      const variants=new Set();
      for (const variant of binding.variants) {
        if (unchanged(current.variants.find((value) => value.id === variant.entryId),
          previous.variants.find((value) => value.id === variant.entryId))) variants.add(variant.entryId);
      }
      if (variants.size>0) packages.set(binding.entryId,variants);
    }
  }
  return Object.freeze({
    itemIds: Object.freeze([...items].sort()),
    packages: Object.freeze([...packages].sort(([a],[b]) => a<b ? -1 : a>b ? 1 : 0)
      .map(([entryId,variants]) => Object.freeze({ entryId,variantIds: Object.freeze([...variants].sort()) }))),
    allowsItem(entryId) { return items.has(id(entryId)); },
    allowsPackage(entryId,variantId) { return packages.get(id(entryId))?.has(id(variantId)) === true; },
  });
}
