import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringAvailabilityQueryPlan } from '../src/domain/catering-availability-query-plan.js';
import { createCateringRequestCommercialSelection } from '../src/domain/catering-request-commercial-selection.js';
import { createCateringOrderSnapshots } from '../src/domain/catering-order-snapshot.js';
import { cateringAvailabilityQueryIntent } from '../src/domain/catering-availability.js';
import { cateringId as id,cateringOrderFixture } from './support/catering-order-fixture.js';
function fixture(options) {
  const source=cateringOrderFixture(options); let sequence=1000;
  const providers=source.connections.map(connection=>({...connection,configurationRevision:2,publicationRevision:1,
    sourceRevision:1,sourceVersion:'synthetic-v1',bindings:source.ownership.assignments
      .filter(value=>value.integrationId === connection.integrationId).map(value=>({kind:value.kind,entryId:value.entryId,
        sourceId:`supplier-${value.entryId}`,
        variants:value.kind === 'item' ? [] : [{entryId:'variant-a',sourceId:'supplier-variant-a'}]}))}));
  const used=new Set(source.ownership.assignments.map(value=>value.integrationId));
  return {...source,providers:providers.filter(value=>used.has(value.integrationId)),
    queryIdFactory:()=>id(sequence++),positionIdFactory:()=>id(sequence++)};
}
test('preconfirmation queries use exact saved slot/requirements and source identities without inventing a confirmed Request',()=>{
  const input=fixture(); input.request.status='Submitted'; const before=JSON.stringify(input);
  const planned=createCateringAvailabilityQueryPlan(input);
  assert.equal(input.request.status,'Submitted'); assert.equal(JSON.stringify(input),before);
  assert.throws(()=>createCateringOrderSnapshots(input));
  assert.equal(planned.length,2); assert.equal(planned[0].integrationId,id(3));
  assert.equal(planned[0].positions[0].sourceId,'supplier-package-a');
  assert.equal(planned[0].positions[0].variantId,'supplier-variant-a'); assert.equal(planned[0].positions[0].quantity,3);
  assert.equal(planned[1].positions[0].sourceId,'supplier-extra-0'); assert.equal(planned[1].positions[0].quantity,2);
  assert.equal(planned[0].startsAt,input.request.startsAt); assert.equal(planned[0].requestVersion,input.request.version);
  assert.equal(planned[0].dietaryRequirements,input.request.snapshot.details.dietaryRequirements);
  assert.equal(planned[0].specialRequirements,input.request.snapshot.details.specialRequirements);
  assert.doesNotMatch(JSON.stringify(planned.map(cateringAvailabilityQueryIntent)),
    /amountMinor|currency|unitPrice|conferencePrice|requester|allocations|orderId|title|tenantId|integrationId/);
});
test('package-included selections remain one commercial package and cannot become additional inventory quantities',()=>{
  const input=fixture(); const selection=createCateringRequestCommercialSelection(input);
  assert.equal(selection[0].positions.length,1);
  assert.deepEqual(selection[0].positions[0].packageDetails.includedSelections,[{itemId:'included-0',quantity:2}]);
  assert.equal(createCateringAvailabilityQueryPlan(input).reduce((sum,value)=>sum+value.positions.length,0),2);
  assert.equal(Object.isFrozen(selection[0].positions[0].packageDetails.includedSelections[0]),true);
});
test('101 commercial positions and all300 package components preserve existing Request capacity',()=>{
  const input=fixture({includedCount:200,extraCount:100,includedSelection:false,quantity:1000,participants:500});
  for (const entry of input.ownership.assignments) entry.integrationId=id(3);
  input.providers=[{...input.providers[0],bindings:input.providers.flatMap(value=>value.bindings)}];
  const [query]=createCateringAvailabilityQueryPlan(input); assert.equal(query.positions.length,101);
  assert.equal(query.positions.filter(value=>value.kind === 'package')[0].quantity,500);
  const large=fixture({includedCount:300,extraCount:0}); const [packageQuery]=createCateringAvailabilityQueryPlan(large);
  assert.equal(packageQuery.positions.length,1);
});
test('same IDs with changed captured names, prices, package contents or variants fail before source queries',()=>{
  for (const change of [
    value=>{value.canonicalCatalogue.cateringItems[0].price.amountMinor++;},
    value=>{value.canonicalCatalogue.cateringItems[0].name='Different meal';},
    value=>{value.canonicalCatalogue.cateringPackages[0].variants[0].description='Different recipe';},
    value=>{value.canonicalCatalogue.cateringPackages[0].itemIds.pop();},
    value=>{value.ownership.catalogueRevision++;},
    value=>{value.ownership.assignments[0].integrationId=id(4);},
  ]) {
    const input=fixture(); change(input); let allocations=0; input.queryIdFactory=()=>{allocations++;return id(1000);};
    assert.throws(()=>createCateringAvailabilityQueryPlan(input)); assert.equal(allocations,0);
  }
});
test('missing, foreign, duplicate or unrelated provider scope, missing source/variant and unsafe source revisions fail closed',()=>{
  for (const change of [
    value=>{value.providers.pop();},value=>{value.providers[0].tenantId=id(9);},
    value=>{value.providers.push(value.providers[0]);},value=>{value.providers[0].integrationId=id(9);},
    value=>{value.providers[0].bindings=[];},value=>{value.providers[0].bindings.find(b=>b.kind === 'package').variants=[];},
    value=>{value.providers[0].bindings=value.providers[0].bindings.filter(b=>b.kind === 'package');},
    value=>{value.providers[0].sourceRevision=0;},value=>{value.providers[0].approved=true;},
  ]) { const input=fixture(); change(input); assert.throws(()=>createCateringAvailabilityQueryPlan(input)); }
});
test('server query/position factories cannot collide within or across providers, and cannot manufacture external identities',()=>{
  for (const invalid of [()=>id(1000),()=> 'supplier-identity']) {
    const input=fixture(); input.positionIdFactory=invalid;
    assert.throws(()=>createCateringAvailabilityQueryPlan(input),/QUERY_PLAN_INVALID/);
  }
  const input=fixture(); input.queryIdFactory=()=>id(999);
  assert.throws(()=>createCateringAvailabilityQueryPlan(input),/QUERY_PLAN_INVALID/);
});
test('commercial source and query values are retained immutable independently of later caller mutation',()=>{
  const input=fixture(); const selected=createCateringRequestCommercialSelection(input);
  const queries=createCateringAvailabilityQueryPlan(input);
  input.canonicalCatalogue.cateringItems[0].name='Changed later'; input.providers[0].bindings[0].sourceId='changed-later';
  assert.equal(selected[0].positions[0].packageDetails.includedItems[0].name,'included-0');
  assert.equal(queries[0].positions[0].sourceId,'supplier-package-a'); assert.equal(Object.isFrozen(queries[0].positions[0]),true);
});
