import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringRequestSourceEvidence as create,normalizeCateringRequestSourceEvidence as normalize,
  carryCateringRequestSourceEvidence as carry,revalidateCateringRequestSourceForAvailability as revalidate
} from '../src/domain/catering-request-source-evidence.js';
import { createCateringAvailabilityQueryPlan } from '../src/domain/catering-availability-query-plan.js';
import { createCateringRequestCommercialSelection } from '../src/domain/catering-request-commercial-selection.js';
import { cateringId as id,cateringOrderFixture } from './support/catering-order-fixture.js';
function fixture(options) {
  const input=cateringOrderFixture(options); input.request.status='Submitted';
  const publications=input.connections.map(scope=>({...scope,configurationRevision:2,reviewRevision:3,publicationRevision:1,
    sourceRevision:1,sourceVersion:'synthetic-v1',bindings:input.ownership.assignments
      .filter(value=>value.integrationId === scope.integrationId).map(value=>({kind:value.kind,entryId:value.entryId,
        sourceId:`supplier-${value.entryId}`,variants:value.kind === 'package'
          ? [{entryId:'variant-a',sourceId:'supplier-variant-a'}] : []}))}));
  return {...input,publications};
}
function next(request,status='In Review') {
  return {...structuredClone(request),version:request.version+1,status,updatedAt:'2026-10-19T09:00:00.000Z',
    statusChangedAt:'2026-10-19T09:00:00.000Z',snapshot:{...structuredClone(request.snapshot),requestVersion:request.version+1}};
}
const expected=input=>({request:input.request,originRequest:input.request,canonicalCatalogue:input.canonicalCatalogue,
  ownership:input.ownership,connections:input.connections});
test('source evidence captures exact Request and immutable provider/review/source references without creating an order',()=>{
  const input=fixture(); const value=create(input);
  assert.equal(value.originRequestVersion,2); assert.equal(value.requestVersion,2); assert.equal(value.catalogueRevision,4);
  assert.equal(value.assignmentRevision,3); assert.match(value.intentFingerprint,/^[0-9a-f]{64}$/);
  assert.equal(value.providers.length,2); assert.equal(value.providers[0].reviewRevision,3);
  assert.equal(value.providers[0].bindings.length,3); assert.equal(value.providers[1].bindings.length,1);
  assert.equal(value.providers[0].bindings.find(v=>v.kind === 'package').variants[0].sourceId,'supplier-variant-a');
  assert.deepEqual(normalize(value,expected(input)),value);
  assert.doesNotMatch(JSON.stringify(value),/amountMinor|currency|dietary|specialRequirements|requester|displayName|orderId|approved/);
  assert.equal(Object.isFrozen(value.providers[0].bindings[0]),true); assert.equal(input.request.status,'Submitted');
});
test('status-only revisions retain actual origin, source bindings and business fingerprint without timestamp inference',()=>{
  const input=fixture(); const first=create(input); const reviewed=next(input.request);
  const second=carry(first,{...expected(input),previousRequest:input.request,request:reviewed});
  assert.equal(second.requestVersion,3); assert.equal(second.originRequestVersion,2);
  assert.equal(second.intentFingerprint,first.intentFingerprint); assert.deepEqual(second.providers,first.providers);
  const confirmed=next(reviewed,'Confirmed');
  const third=carry(second,{...expected(input),previousRequest:reviewed,request:confirmed});
  assert.equal(third.requestVersion,4); assert.equal(third.originRequestVersion,2);
  assert.deepEqual(normalize(third,{...expected(input),request:confirmed}),third);
});
test('changed quantities, slot, requirements, price or owner cannot inherit a previous source intent',()=>{
  const input=fixture(); const evidence=create(input);
  for (const changed of [fixture({quantity:3}).request,fixture({startsAt:'2026-10-21T10:00:00.000Z'}).request,
    fixture({unitPrice:101}).request]) {
    const request=next(changed);
    assert.throws(()=>carry(evidence,{...expected(input),previousRequest:input.request,request}));
  }
  const request=next(input.request); request.snapshot.details.dietaryRequirements='Changed meal requirement';
  assert.throws(()=>carry(evidence,{...expected(input),previousRequest:input.request,request}));
  const changed=fixture(); changed.ownership.assignments.forEach(v=>{if(v.integrationId === id(4))v.integrationId=id(3);});
  assert.throws(()=>normalize(evidence,{...expected(changed),request:input.request,originRequest:input.request}));
});
test('database JSON object ordering and equivalent provider/binding ordering do not invalidate retained evidence',()=>{
  const input=fixture(); const value=create(input);
  const reorder=entry=>Array.isArray(entry) ? entry.map(reorder)
    : entry && typeof entry === 'object' ? Object.fromEntries(Object.entries(entry).reverse().map(([k,v])=>[k,reorder(v)])) : entry;
  const stored=reorder(value); stored.providers.reverse(); stored.providers[0].bindings.reverse();
  assert.deepEqual(normalize(stored,expected(input)),value);
});
test('forged Tenant, Request/origin version, references, extra authority and corrupted fingerprint fail closed',()=>{
  const input=fixture(); const value=create(input);
  for (const change of [{tenantId:id(9)},{requestId:'foreign'},{requestVersion:3},{originRequestVersion:1},
    {catalogueRevision:5},{assignmentRevision:0},{intentFingerprint:'0'.repeat(64)},{approved:true}]) {
    assert.throws(()=>normalize({...value,...change},expected(input)));
  }
  for (const change of [{reviewRevision:0},{sourceRevision:-1},{sourceVersion:' unsafe '},{tenantId:id(9)}]) {
    const altered=fixture(); altered.publications[0]={...altered.publications[0],...change}; assert.throws(()=>create(altered));
  }
  assert.throws(()=>normalize(value,{...expected(input),originRequest:fixture({requestVersion:1}).request}));
});
test('omitted selected source bindings and variants, unrelated provider contexts and duplicate sources cannot establish capture',()=>{
  for (const change of [
    value=>{value.publications.pop();},value=>{value.publications.push(value.publications[0]);},
    value=>{value.publications[0].bindings=[];},
    value=>{value.publications[0].bindings=value.publications[0].bindings.filter(v=>v.kind === 'package');},
    value=>{value.publications[0].bindings.find(v=>v.kind === 'package').variants=[];},
  ]) { const input=fixture(); change(input); assert.throws(()=>create(input)); }
});
test('captured subset excludes unrelated offers and unselected variants while every included package component is retained',()=>{
  const input=fixture(); const value=create(input);
  const extra={...input.canonicalCatalogue.cateringItems[0],id:'not-selected'};
  input.canonicalCatalogue.cateringItems.push(extra);
  input.ownership.assignments.push({kind:'item',entryId:extra.id,integrationId:id(3)});
  input.publications[0].bindings.push({kind:'item',entryId:extra.id,sourceId:'supplier-not-selected',variants:[]});
  assert.deepEqual(create(input),value);
  const forged=structuredClone(value); forged.providers[0].bindings.push(input.publications[0].bindings.at(-1));
  assert.throws(()=>normalize(forged,expected(input)));
});
test('carry requires the immediate next real revision and rejects missing evidence, hidden getters or guessed origin',()=>{
  const input=fixture(); const value=create(input); const request=next(next(input.request));
  assert.throws(()=>carry(value,{...expected(input),previousRequest:input.request,request}));
  assert.throws(()=>normalize(null,expected(input))); let reads=0;
  const hidden=structuredClone(value);
  Object.defineProperty(hidden,'providers',{enumerable:true,get(){reads++;return [];}});
  assert.throws(()=>normalize(hidden,expected(input))); assert.equal(reads,0);
});

test('an empty Catering selection records no inferred supplier and can retain the actual zero assignment head',()=>{
  const input=fixture(); input.request=structuredClone(input.request); const snapshot=input.request.snapshot;
  snapshot.details.catering={participantCount:0,packageSelection:null,itemQuantities:[]};
  snapshot.pricing.catering={participantCount:0,packageSelection:null,items:[]}; snapshot.pricing.totalMinor=0;
  snapshot.pricing.breakdown.cateringPackageMinor=0; snapshot.pricing.breakdown.cateringItemsMinor=0;
  snapshot.allocations.totalMinor=0; snapshot.allocations.allocatedMinor=0; snapshot.allocations.entries[0].allocatedMinor=0;
  input.assignmentRevision=0; input.publications=[]; input.ownership={schemaVersion:1,catalogueRevision:4,assignments:[]};
  const value=create(input); assert.deepEqual(value.providers,[]); assert.equal(value.assignmentRevision,0);
  assert.deepEqual(normalize(value,expected(input)),value);
  assert.equal(carry(value,{...expected(input),previousRequest:input.request,request:next(input.request)}).originRequestVersion,2);
  assert.throws(()=>create({...fixture(),assignmentRevision:0}));
});
test('all101 independently owned commercial positions retain their exact providers without reducing Request capacity',()=>{
  const input=fixture({includedCount:200,extraCount:100,includedSelection:false,quantity:1000,participants:500});
  for (const entry of input.ownership.assignments) {
    if (entry.entryId.startsWith('extra-')) entry.integrationId=id(100+Number(entry.entryId.slice(6)));
  }
  const ids=[...new Set(input.ownership.assignments.map(v=>v.integrationId))];
  input.connections=ids.map(integrationId=>({tenantId:id(1),integrationId}));
  input.publications=input.connections.map(scope=>({...scope,configurationRevision:2,reviewRevision:3,publicationRevision:1,
    sourceRevision:1,sourceVersion:null,bindings:input.ownership.assignments.filter(v=>v.integrationId === scope.integrationId)
      .map(v=>({kind:v.kind,entryId:v.entryId,sourceId:`supplier-${v.entryId}`,variants:v.kind === 'package'
        ? [{entryId:'variant-a',sourceId:'supplier-variant-a'}] : []}))}));
  const value=create(input); assert.equal(value.providers.length,101);
  assert.equal(value.providers.reduce((sum,v)=>sum+v.bindings.length,0),301);
  assert.deepEqual(normalize(value,expected(input)),value);
  input.publications.push(input.publications[0]); assert.throws(()=>create(input));
});

function current(input) {
  const currentCatalogue=structuredClone(input.canonicalCatalogue);
  const currentOwnership=structuredClone(input.ownership); currentOwnership.catalogueRevision++;
  const currentPublications=structuredClone(input.publications).map(value=>({...value,configurationRevision:3,
    reviewRevision:4,publicationRevision:2,sourceRevision:2,sourceVersion:'synthetic-v2'}));
  return {...expected(input),currentCatalogue,currentCatalogueRevision:5,currentOwnership,
    currentConnections:structuredClone(input.connections),currentPublications};
}
test('current source revalidation tolerates unrelated catalogue/assignment/publication changes without altering a saved Request',()=>{
  const input=fixture(); const captured=create(input); const state=current(input);
  const extra={...state.currentCatalogue.cateringItems[0],id:'unselected-new'};
  state.currentCatalogue.cateringItems.push(extra);
  state.currentOwnership.assignments.push({kind:'item',entryId:extra.id,integrationId:id(3)});
  state.currentPublications[0].bindings.push({kind:'item',entryId:extra.id,sourceId:'supplier-unselected-new',variants:[]});
  const before=JSON.stringify(input.request); const providers=revalidate(captured,state);
  assert.equal(providers.length,2); assert.equal(providers[0].configurationRevision,3);
  assert.equal(providers[0].sourceRevision,2); assert.equal(providers[0].publicationRevision,2);
  assert.equal(captured.providers[0].sourceRevision,1); assert.equal(JSON.stringify(input.request),before);
  assert.throws(()=>createCateringRequestCommercialSelection({...input,ownership:state.currentOwnership,
    canonicalCatalogue:state.currentCatalogue,connections:state.currentConnections}));
  let sequence=5000; const queries=createCateringAvailabilityQueryPlan({...input,providers,
    queryIdFactory:()=>id(sequence++),positionIdFactory:()=>id(sequence++)});
  assert.equal(queries[0].sourceRevision,2); assert.equal(queries[0].requestVersion,2);
  assert.equal(queries[0].positions[0].sourceId,'supplier-package-a'); assert.equal(input.request.status,'Submitted');
});
test('same canonical meal IDs cannot launder a changed supplier SKU, variant or included component mapping',()=>{
  for (const change of [
    state=>{state.currentPublications[1].bindings[0].sourceId='different-supplier-sku';},
    state=>{state.currentPublications[0].bindings.find(v=>v.kind === 'package').variants[0].sourceId='different-variant';},
    state=>{state.currentPublications[0].bindings.find(v=>v.kind === 'item').sourceId='different-component';},
  ]) { const input=fixture(); const state=current(input); change(state); assert.throws(()=>revalidate(create(input),state)); }
});
test('changed current commercial content, price, package components or supplier owner requires explicit new composition',()=>{
  for (const change of [
    state=>{state.currentCatalogue.cateringItems[0].price.amountMinor++;},
    state=>{state.currentCatalogue.cateringItems[0].name='Different recipe';},
    state=>{state.currentCatalogue.cateringPackages[0].variants[0].description='Different meal';},
    state=>{state.currentCatalogue.cateringPackages[0].itemIds.pop();},
    state=>{state.currentOwnership.assignments.forEach(v=>{if(v.integrationId === id(4))v.integrationId=id(3);});},
  ]) { const input=fixture(); const state=current(input); change(state); assert.throws(()=>revalidate(create(input),state)); }
});
test('independently supplied current revision, connection scope and complete source context fail closed when stale or forged',()=>{
  for (const change of [
    state=>{state.currentCatalogueRevision=4;},state=>{state.currentCatalogueRevision=0;},
    state=>{state.currentConnections[0].tenantId=id(9);},state=>{state.currentPublications.pop();},
    state=>{state.currentPublications[0].tenantId=id(9);},state=>{state.currentPublications[0].publicationRevision=0;},
    state=>{state.currentPublications[0].bindings=state.currentPublications[0].bindings.filter(v=>v.kind === 'package');},
  ]) { const input=fixture(); const state=current(input); change(state); assert.throws(()=>revalidate(create(input),state)); }
});
