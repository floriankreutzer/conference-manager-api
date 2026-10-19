import { createHash } from 'node:crypto';
import { isInternalUuid } from './identifiers.js';
import { REQUEST_MAX_PARTICIPANTS } from './request-composition.js';
import { CATERING_MAX_ORDER_POSITIONS } from './catering-order-limits.js';
import { normalizeCateringProviderTerms } from './catering-provider-catalogue.js';

export const CATERING_MAX_AVAILABILITY_AGE_MS=3600000;
const QUERY_KEYS=['schemaVersion','queryId','configurationRevision','publicationRevision','sourceRevision','sourceVersion',
  'siteId','roomId','startsAt','endsAt','participantCount','positions'];
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STATUSES=new Set(['available','unavailable','unknown']);
function invalid() { throw new TypeError('CATERING_AVAILABILITY_VALUE_INVALID'); }
function record(value,keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(name=>{
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
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
function integer(value,minimum=1,maximum=Number.MAX_SAFE_INTEGER-1) {
  if (!Number.isSafeInteger(value) || value<minimum || value>maximum) invalid(); return value;
}
function text(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.isWellFormed()
    || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) invalid();
  const normalized=value.trim().normalize('NFC'); if (!normalized.length || normalized.length>160) invalid(); return normalized;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
  const parsed=Date.parse(value); const canonical=value.includes('.') ? value : value.slice(0,-1)+'.000Z';
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== canonical) invalid(); return canonical;
}
const naturalKey=value=>`${value.kind}:${value.sourceId}:${value.variantId ?? ''}`;
const compare=(a,b)=>naturalKey(a)<naturalKey(b) ? -1 : naturalKey(a)>naturalKey(b) ? 1 : 0;
function fingerprint(query,scope) {
  const {queryId:_queryId,positions,...context}=query;
  return createHash('sha256').update(JSON.stringify({...scope,...context,
    positions:positions.map(({positionId:_positionId,...value})=>value)})).digest('hex');
}

// Query values only. Current publication/ownership and the exact slot/quantities
// must be independently resolved by the authorized use case before this boundary.
export function normalizeCateringAvailabilityQuery(value,scope) {
  record(scope,['tenantId','integrationId']); const tenantId=uuid(scope.tenantId); const integrationId=uuid(scope.integrationId);
  record(value,QUERY_KEYS); if (value.schemaVersion !== 1) invalid();
  const startsAt=instant(value.startsAt); const endsAt=instant(value.endsAt); if (endsAt<=startsAt) invalid();
  const participantCount=integer(value.participantCount,0,REQUEST_MAX_PARTICIPANTS);
  const positions=array(value.positions,CATERING_MAX_ORDER_POSITIONS).map(position=>{
    record(position,['positionId','kind','sourceId','variantId','quantity']);
    if (!['item','package'].includes(position.kind)) invalid(); const group=position.kind === 'package';
    if (!group && position.variantId !== null) invalid();
    const variantId=group ? id(position.variantId) : null;
    const quantity=integer(position.quantity,1,group ? REQUEST_MAX_PARTICIPANTS : 1000);
    if (group && quantity !== participantCount) invalid();
    return Object.freeze({positionId:uuid(position.positionId),kind:position.kind,sourceId:id(position.sourceId),variantId,quantity});
  }).sort(compare);
  if (!positions.length || positions.filter(position=>position.kind === 'package').length>1
    || positions.filter(position=>position.kind === 'item').length>100
    || new Set(positions.map(position=>position.positionId)).size !== positions.length
    || new Set(positions.map(naturalKey)).size !== positions.length) invalid();
  const query=Object.freeze({schemaVersion:1,queryId:uuid(value.queryId),configurationRevision:integer(value.configurationRevision),
    publicationRevision:integer(value.publicationRevision),sourceRevision:integer(value.sourceRevision),
    sourceVersion:text(value.sourceVersion),
    siteId:id(value.siteId),roomId:id(value.roomId),startsAt,endsAt,participantCount,positions:Object.freeze(positions)});
  return Object.freeze({tenantId,integrationId,...query,queryFingerprint:fingerprint(query,{tenantId,integrationId})});
}

// A provider echoes only the immutable query/position identities and factual
// statuses/terms. Revision, receipt clock, Tenant and freshness policy are server
// evidence; they cannot be supplied by this response or turn it into a reservation.
export function normalizeCateringAvailabilityObservation(value,expected) {
  record(expected,['tenantId','integrationId','query','receivedAt','maximumAgeMs']);
  const query=normalizeCateringAvailabilityQuery(expected.query,{tenantId:expected.tenantId,integrationId:expected.integrationId});
  const receivedAt=instant(expected.receivedAt); const maximumAgeMs=integer(expected.maximumAgeMs,1,CATERING_MAX_AVAILABILITY_AGE_MS);
  record(value,['schemaVersion','queryId','availabilityVersion','observedAt','validUntil','positions','terms']);
  if (value.schemaVersion !== 1 || uuid(value.queryId) !== query.queryId) invalid();
  const observedAt=instant(value.observedAt); if (observedAt>receivedAt) invalid();
  const providerValidUntil=value.validUntil === null ? null : instant(value.validUntil);
  if (providerValidUntil !== null && providerValidUntil<=observedAt) invalid();
  const positions=array(value.positions,CATERING_MAX_ORDER_POSITIONS).map(position=>{
    record(position,['positionId','status']); const positionId=uuid(position.positionId);
    if (!STATUSES.has(position.status) || !query.positions.some(entry=>entry.positionId === positionId)) invalid();
    return Object.freeze({positionId,status:position.status});
  });
  if (positions.length !== query.positions.length
    || new Set(positions.map(position=>position.positionId)).size !== positions.length) invalid();
  const byId=new Map(positions.map(position=>[position.positionId,position]));
  const validUntil=providerValidUntil === null ? null
    : new Date(Math.min(Date.parse(providerValidUntil),Date.parse(observedAt)+maximumAgeMs)).toISOString();
  return Object.freeze({schemaVersion:1,tenantId:query.tenantId,integrationId:query.integrationId,queryId:query.queryId,
    queryFingerprint:query.queryFingerprint,configurationRevision:query.configurationRevision,publicationRevision:query.publicationRevision,
    sourceRevision:query.sourceRevision,availabilityVersion:text(value.availabilityVersion),
    observedAt,receivedAt,providerValidUntil,validUntil,
    positions:Object.freeze(query.positions.map(position=>byId.get(position.positionId))),
    terms:normalizeCateringProviderTerms(value.terms)});
}

// Necessary factual freshness only. Every use repeats current basis and timing;
// this value is advisory and cannot release an order or mutate a confirmed one.
export function evaluateCateringAvailability(value,expected) {
  record(expected,['tenantId','integrationId','query','receivedAt','maximumAgeMs',
    'configurationRevision','publicationRevision','publishedSourceRevision','now']);
  const observation=normalizeCateringAvailabilityObservation(value,{tenantId:expected.tenantId,integrationId:expected.integrationId,
    query:expected.query,receivedAt:expected.receivedAt,maximumAgeMs:expected.maximumAgeMs});
  const now=instant(expected.now); const reasons=[];
  if (integer(expected.configurationRevision) !== observation.configurationRevision
    || integer(expected.publicationRevision) !== observation.publicationRevision
    || integer(expected.publishedSourceRevision) !== observation.sourceRevision) reasons.push('availability_basis_changed');
  if (now<observation.receivedAt) reasons.push('availability_time_unverified');
  if (observation.validUntil === null) reasons.push('availability_validity_unknown');
  else if (now>=observation.validUntil) reasons.push('availability_expired');
  if (observation.positions.some(position=>position.status === 'unavailable')) reasons.push('unavailable');
  if (observation.positions.some(position=>position.status === 'unknown')) reasons.push('availability_unknown');
  return Object.freeze({available:reasons.length === 0,reasons:Object.freeze(reasons),validUntil:observation.validUntil,
    availabilityVersion:observation.availabilityVersion,positions:observation.positions,terms:observation.terms});
}
