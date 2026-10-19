import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringPublishedOfferIndex as index } from '../src/domain/catering-published-offers.js';

const uuid=(n)=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const price=(amountMinor=700)=>({amountMinor,currency:'EUR'});
const entry=(id)=>({id,name:`Synthetic ${id}`,description:null,price:price(),active:true,order:0,siteIds:[],roomIds:[]});
const variant=(id)=>({id,name:`Synthetic ${id}`,description:null,price:price(),active:true,order:0});
function fixture() {
  const catalogue={services:[],equipment:[],roomPrices:[],cateringItems:[entry('coffee'),entry('fruit')],
    cateringPackages:[{...entry('break'),itemIds:['coffee'],variants:[variant('standard')]}]};
  const expected={tenantId:uuid(1),catalogue,assignments:[
    {kind:'item',entryId:'coffee',integrationId:uuid(3)},{kind:'item',entryId:'fruit',integrationId:uuid(4)},
    {kind:'package',entryId:'break',integrationId:uuid(3)}]};
  const publications=[{tenantId:uuid(1),integrationId:uuid(3),publicationRevision:1,catalogueRevision:2,sourceRevision:1,
    connectionAvailable:true,catalogueEnabled:true,catalogue:structuredClone(catalogue),bindings:[
      {kind:'item',entryId:'coffee',sourceId:'supplier-coffee',variants:[]},
      {kind:'package',entryId:'break',sourceId:'supplier-break',variants:[{entryId:'standard',sourceId:'supplier-standard'}]}]}];
  return {expected,publications};
}
test('only explicitly published current own offers/variants appear, with no supplier costs or order authority',()=>{
  const f=fixture(); const value=index(f.publications,f.expected);
  assert.deepEqual(value.itemIds,['coffee']); assert.equal(value.allowsItem('fruit'),false);
  assert.equal(value.allowsPackage('break','standard'),true); assert.equal(value.allowsPackage('break','unpublished'),false);
  assert.deepEqual(value.packages,[{entryId:'break',variantIds:['standard']}]);
  assert.equal(Object.isFrozen(value.packages[0].variantIds),true);
  assert.doesNotMatch(JSON.stringify(value),/price|supplier|available|tenantId|integrationId|approved/);
  assert.deepEqual(index([],f.expected).itemIds,[]);
});
test('unrelated canonical revisions and presentation sorting do not silently unpublish unchanged offers',()=>{
  const f=fixture(); f.expected.catalogue.services.push(entry('service'));
  f.expected.catalogue.cateringItems[1].price=price(999); f.expected.catalogue.cateringItems[0].order=100;
  f.expected.catalogue.cateringPackages[0].order=42; f.expected.catalogue.cateringPackages[0].variants[0].order=12;
  const value=index(f.publications,f.expected); assert.equal(value.allowsItem('coffee'),true);
  assert.equal(value.allowsPackage('break','standard'),true);
});
test('any unreviewed current item price/content/applicability/active change hides the item and dependent packages',()=>{
  for (const change of [{price:price(701)},{name:'Unreviewed name'},{description:'Unreviewed description'},
    {siteIds:['site-1']},{roomIds:['room-1']},{active:false}]) {
    const f=fixture(); Object.assign(f.expected.catalogue.cateringItems[0],change);
    if (change.siteIds) f.expected.catalogue.cateringPackages[0].siteIds=change.siteIds;
    if (change.roomIds) f.expected.catalogue.cateringPackages[0].roomIds=change.roomIds;
    if (change.active === false) f.expected.catalogue.cateringPackages[0].active=false;
    const value=index(f.publications,f.expected);
    assert.equal(value.allowsItem('coffee'),false); assert.equal(value.allowsPackage('break','standard'),false);
  }
});
test('package base changes require review while a new unpublished or changed variant does not erase other approved variants',()=>{
  for (const change of [{price:price(702)},{name:'Unreviewed package'},{siteIds:['site-1']},{itemIds:['coffee','fruit']}]) {
    const f=fixture(); Object.assign(f.expected.catalogue.cateringPackages[0],change);
    assert.equal(index(f.publications,f.expected).allowsPackage('break','standard'),false);
  }
  const f=fixture(); f.expected.catalogue.cateringPackages[0].variants.push(variant('new'));
  let value=index(f.publications,f.expected); assert.equal(value.allowsPackage('break','standard'),true);
  assert.equal(value.allowsPackage('break','new'),false);
  f.expected.catalogue.cateringPackages[0].variants[0].price=price(1000);
  value=index(f.publications,f.expected); assert.equal(value.allowsPackage('break','standard'),false);
  assert.equal(value.allowsItem('coffee'),true);
});
test('current ownership, connection and catalogue capability independently fence publication eligibility',()=>{
  for (const mutate of [f=>{f.expected.assignments[0].integrationId=uuid(4);},
    f=>{f.expected.assignments[2].integrationId=uuid(4);},f=>{f.publications[0].connectionAvailable=false;},
    f=>{f.publications[0].catalogueEnabled=false;},f=>{f.expected.assignments=[];}]) {
    const f=fixture(); mutate(f); assert.equal(index(f.publications,f.expected).allowsPackage('break','standard'),false);
  }
});
test('package components must be included in that same publication and remain assigned to the same provider',()=>{
  const f=fixture(); f.publications[0].bindings.shift();
  assert.equal(index(f.publications,f.expected).allowsPackage('break','standard'),false);
});
test('no availability object, new receipt or source version can overwrite captured publication evidence',()=>{
  const f=fixture(); const before=JSON.stringify(f); const value=index(f.publications,f.expected);
  assert.equal(JSON.stringify(f),before); f.expected.catalogue.cateringItems[0].price=price(1);
  f.publications[0].bindings=[]; assert.equal(value.allowsItem('coffee'),true);
  assert.deepEqual(value.itemIds,['coffee']);
});
test('foreign scope, impossible revisions, duplicate ownership/publication and private or executable shapes fail closed',()=>{
  for (const mutate of [f=>{f.publications[0].tenantId=uuid(2);},f=>{f.publications.push(f.publications[0]);},
    f=>{f.expected.assignments.push(f.expected.assignments[0]);},f=>{f.publications[0].publicationRevision=0;},
    f=>{f.publications[0].connectionAvailable='true';},f=>{f.publications[0].supplierCost=price();},
    f=>{f.expected.availability=true;},f=>{f.publications[0].bindings[0].entryId='absent';}]) {
    const f=fixture(); mutate(f); assert.throws(()=>index(f.publications,f.expected));
  }
  const f=fixture(); let reads=0; Object.defineProperty(f.publications[0],'bindings',{enumerable:true,get(){reads++;return [];}});
  assert.throws(()=>index(f.publications,f.expected)); assert.equal(reads,0);
  assert.throws(()=>index(Array(1),fixture().expected));
});
test('retained unpublished entries and removed variants never acquire eligibility through matching names or prices',()=>{
  const f=fixture(); f.expected.catalogue.cateringItems.push(entry('new-coffee'));
  f.expected.assignments.push({kind:'item',entryId:'new-coffee',integrationId:uuid(3)});
  f.expected.catalogue.cateringPackages[0].variants=[];
  const value=index(f.publications,f.expected); assert.equal(value.allowsItem('new-coffee'),false);
  assert.equal(value.allowsPackage('break','standard'),false);
});

test('an impossible active package referencing an inactive component is rejected as corrupt canonical evidence',()=>{
  const f=fixture(); f.expected.catalogue.cateringItems[0].active=false;
  assert.throws(()=>index(f.publications,f.expected),/PACKAGE_ITEM_REFERENCE_INVALID/);
});
test('full300-item/100-package/20-variant publication remains eligible without narrowing canonical capacity',()=>{
  const f=fixture(); const catalogue={services:[],equipment:[],roomPrices:[],
    cateringItems:Array.from({length:300},(_,i)=>entry(`item-${i}`)),
    cateringPackages:Array.from({length:100},(_,i)=>({...entry(`package-${i}`),itemIds:[`item-${i}`],
      variants:Array.from({length:20},(_,j)=>variant(`variant-${j}`))}))};
  f.expected.catalogue=catalogue; f.publications[0].catalogue=structuredClone(catalogue);
  f.expected.assignments=[...catalogue.cateringItems.map(x=>({kind:'item',entryId:x.id,integrationId:uuid(3)})),
    ...catalogue.cateringPackages.map(x=>({kind:'package',entryId:x.id,integrationId:uuid(3)}))];
  f.publications[0].bindings=[...catalogue.cateringItems.map(x=>({kind:'item',entryId:x.id,sourceId:`source-${x.id}`,variants:[]})),
    ...catalogue.cateringPackages.map(x=>({kind:'package',entryId:x.id,sourceId:`source-${x.id}`,
      variants:x.variants.map(v=>({entryId:v.id,sourceId:`source-${v.id}`}))}))];
  const value=index(f.publications,f.expected); assert.equal(value.itemIds.length,300); assert.equal(value.packages.length,100);
  assert.equal(value.packages.reduce((sum,x)=>sum+x.variantIds.length,0),2000);
});

test('trusted selections require current site/room applicability for direct items, packages and every included item',()=>{
  const f=fixture(); for (const catalogue of [f.expected.catalogue,f.publications[0].catalogue]) {
    catalogue.cateringItems[0].siteIds=['site-a']; catalogue.cateringItems[0].roomIds=['room-a'];
    catalogue.cateringPackages[0].siteIds=['site-a']; catalogue.cateringPackages[0].roomIds=['room-a'];
  }
  const value=index(f.publications,f.expected); const selection={siteId:'site-a',roomId:'room-a',itemIds:['coffee'],
    packageSelection:{packageId:'break',variantId:'standard'}};
  assert.equal(value.allowsSelection(selection),true);
  assert.equal(value.allowsSelection({...selection,siteId:'site-b'}),false);
  assert.equal(value.allowsSelection({...selection,roomId:'room-b'}),false);
  assert.equal(value.allowsSelection({...selection,itemIds:['fruit']}),false);
  assert.equal(value.allowsSelection({...selection,itemIds:[],packageSelection:null}),true);
  assert.throws(()=>value.allowsSelection({...selection,tenantId:uuid(2)}));
  assert.throws(()=>value.allowsSelection({...selection,itemIds:['coffee','coffee']}));
});
