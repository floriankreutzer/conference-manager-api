import { createCustomerComposition } from '../src/customer-composition.js';
import { createPostgresPersistence } from '../src/persistence/postgres/index.js';
import { loadConfig } from '../src/config.js';
import { createCateringConfigurationRegistry } from '../src/integrations/catering-provider-registration.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCateringPublishedOffersWithClient,cateringSnapshotRemainsPublishedWithClient,lockCateringPublishedOfferAuthorityWithClient
} from '../src/persistence/postgres/catering-published-offers.js';
const registry=createCateringConfigurationRegistry();
const tenantId='e0000000-0000-4000-8000-000000000001';
const integrationId='e0000000-0000-4000-8000-000000000003';
const entry={id:'coffee',name:'Synthetic coffee',description:null,price:{amountMinor:0,currency:'EUR'},
  active:true,order:0,siteIds:['site-a'],roomIds:['room-a']};
const catalogue={services:[],equipment:[],roomPrices:[],cateringItems:[entry],cateringPackages:[]};
function fixture({foreign=false,sourceMismatch=false,disabled=false,missingCurrent=false,ownersOverflow=false}={}) {
  const calls=[]; const client={async query(query){
    calls.push(query); assert.equal(query.values[0],tenantId);
    if (query.name==='catering-published-offers-authority-lock') return {rows:[{id:integrationId}]};
    if (query.name==='catering-published-offers-current-room') return {rowCount:1,rows:[{site_id:'site-a'}]};
    if (query.name==='catering-published-offers-current-catalogue') {
      return missingCurrent ? {rowCount:0,rows:[]} : {rowCount:1,rows:[{snapshot:catalogue}]};
    }
    if (query.name==='catering-published-offers-current-owners') return {rows:ownersOverflow ? Array(401).fill({}) : [
      {kind:'item',entry_id:'coffee',integration_id:integrationId}]};
    assert.equal(query.name,'catering-published-offers-current-publications');
    return {rows:[{tenant_id:foreign ? integrationId : tenantId,integration_id:integrationId,
      publication_revision:'1',catalogue_revision:'2',source_revision:'1',provider:'manual_catering',
      source_provider:sourceMismatch ? 'foreign' : 'manual_catering',status:disabled ? 'disabled' : 'configured',
      initial_order_mode:'manager_review',catalogue_mode:'manual',availability_mode:'unsupported',order_mode:'manual',
      update_mode:'unsupported',cancel_mode:'unsupported',status_mode:'unsupported',published_catalogue:catalogue,
      bindings:[{kind:'item',entryId:'coffee',sourceId:'supplier-coffee',variants:[]}]}]};
  }};
  return {client,calls};
}
test('same-client publication read keeps scope/version parameters and exposes immutable IDs without private evidence',async()=>{
  const f=fixture(); const value=await readCateringPublishedOffersWithClient(f.client,{registry,tenantId,catalogueRevision:2});
  assert.deepEqual(value.itemIds,['coffee']); assert.equal(f.calls.length,3);
  assert.deepEqual(f.calls[0].values,[tenantId,2]); assert.equal(Object.isFrozen(value.itemIds),true);
  assert.doesNotMatch(JSON.stringify(value),/supplier|price|tenantId|integrationId|revision/);
});
test('stale, foreign and oversized ownership evidence fails before eligibility is exposed',async()=>{
  for (const options of [{foreign:true},{sourceMismatch:true},{missingCurrent:true},{ownersOverflow:true}]) {
    const f=fixture(options); await assert.rejects(readCateringPublishedOffersWithClient(f.client,{registry,tenantId,catalogueRevision:2}));
    if (options.missingCurrent) assert.equal(f.calls.length,1);
    if (options.ownersOverflow) assert.equal(f.calls.length,2);
  }
  const f=fixture({disabled:true});
  assert.deepEqual((await readCateringPublishedOffersWithClient(f.client,{registry,tenantId})).itemIds,[]);
});
test('final snapshot checks current room scope; empty and legacy snapshots add no read',async()=>{
  const f=fixture(); const snapshot={details:{catering:{itemQuantities:[{itemId:'coffee',quantity:1}],packageSelection:null}}};
  assert.equal(await cateringSnapshotRemainsPublishedWithClient(f.client,{registry,tenantId,snapshot,roomId:'room-a'}),true);
  assert.equal(f.calls.length,4); assert.deepEqual(f.calls[0].values,[tenantId,'room-a']);
  assert.deepEqual(f.calls[1].values,[tenantId,null]);
  assert.equal(await cateringSnapshotRemainsPublishedWithClient(f.client,{registry,tenantId,snapshot,roomId:'room-b'}),false);
  const count=f.calls.length;
  assert.equal(await cateringSnapshotRemainsPublishedWithClient(f.client,{registry,tenantId,snapshot:null,roomId:'room-a'}),true);
  assert.equal(await cateringSnapshotRemainsPublishedWithClient(f.client,{registry,tenantId,roomId:'room-a',
    snapshot:{details:{catering:{itemQuantities:[],packageSelection:null}}}}),true);
  assert.equal(f.calls.length,count);
});
test('forged scope/revision/policy options and absent normalized snapshot fail before a database read',async()=>{
  const f=fixture();
  for (const options of [{registry,tenantId:'foreign'},{registry,tenantId,catalogueRevision:0},{registry,tenantId,catalogueRevision:'2'}]) {
    await assert.rejects(readCateringPublishedOffersWithClient(f.client,options));
  }
  await assert.rejects(cateringSnapshotRemainsPublishedWithClient(f.client,{registry,tenantId,roomId:'room-a'}));
  assert.equal(f.calls.length,0);
});

test('final change approval fences current assigned integration/configuration rows on the existing client',async()=>{
  const f=fixture(); await lockCateringPublishedOfferAuthorityWithClient(f.client,tenantId);
  assert.equal(f.calls.length,1); assert.deepEqual(f.calls[0].values,[tenantId]);
  assert.match(f.calls[0].text,/FOR SHARE OF integration,configuration/);
  await assert.rejects(lockCateringPublishedOfferAuthorityWithClient(f.client,'foreign'));
  assert.equal(f.calls.length,1);
});

test('enabled Customer composition injects the registry without provider or database I/O',async()=>{
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:'postgres://localhost:1/synthetic',DATABASE_SSL:'disable',
    CATERING_CONFIGURATION_ENABLED:'true',AUDIT_HMAC_SECRET:'a'.repeat(32),CSRF_SECRET:'c'.repeat(32),
    OIDC_TRANSACTION_SECRET:'o'.repeat(32),ENTRA_CLIENT_ID:tenantId,ENTRA_CLIENT_SECRET:'e'.repeat(32)});
  assert.throws(()=>createPostgresPersistence(config),/CATERING_REGISTRY_REQUIRED/);
  let calls=0; const forbidden=()=>{calls++;throw new Error('SYNTHETIC_PROVIDER_CALL_FORBIDDEN');};
  const microsoft365Client=Object.fromEntries(['lookupFreeBusy','adminConsentUrl','verifyBasePermissions','discoverRooms']
    .map(method=>[method,forbidden]));
  const runtime=createCustomerComposition({config,microsoft365Client,logger:{lifecycle(){}}});
  try { assert.equal(typeof runtime.start,'function'); assert.equal(calls,0); } finally { await runtime.stop(); }
  assert.equal(calls,0);
});
