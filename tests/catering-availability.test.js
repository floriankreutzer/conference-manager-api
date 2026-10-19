import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCateringAvailabilityQuery as query,normalizeCateringAvailabilityObservation as observation,
  evaluateCateringAvailability as evaluate } from '../src/domain/catering-availability.js';
const id=n=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={tenantId:id(1),integrationId:id(3)};
const position=(n,kind='item')=>({positionId:id(100+n),kind,sourceId:`supplier-${kind}-${n}`,
  variantId:kind === 'package' ? 'supplier-standard' : null,quantity:kind === 'package' ? 3 : 2});
const input=()=>({schemaVersion:1,queryId:id(10),configurationRevision:2,publicationRevision:1,sourceRevision:1,sourceVersion:null,
  siteId:'site-a',roomId:'room-a',startsAt:'2026-10-20T12:00:00.000Z',endsAt:'2026-10-20T13:00:00.000Z',participantCount:3,
  positions:[position(0),position(1,'package')]});
const terms=()=>({minimumLeadTimeMinutes:120,minimumOrderValue:null,changeCutoffMinutes:null,cancelCutoffMinutes:0});
const reply=(request=input())=>({schemaVersion:1,queryId:request.queryId,availabilityVersion:'synthetic-observation-1',
  observedAt:'2026-10-19T12:00:00.000Z',validUntil:'2026-10-19T12:30:00.000Z',
  positions:request.positions.map(({positionId})=>({positionId,status:'available'})),terms:terms()});
const expected=(overrides={})=>({...scope,query:input(),receivedAt:'2026-10-19T12:00:01.000Z',maximumAgeMs:300000,...overrides});
const current=(overrides={})=>({...expected(),configurationRevision:2,publicationRevision:1,publishedSourceRevision:1,
  now:'2026-10-19T12:01:00.000Z',...overrides});
test('query scope, slot, published basis and exact quantities are immutable and canonicalized for a private context fingerprint',()=>{
  const raw=input(); const value=query(raw,scope); const reordered={...raw,queryId:id(11),positions:[...raw.positions].reverse()
    .map((entry,n)=>({...entry,positionId:id(200+n)}))};
  assert.equal(query(reordered,scope).queryFingerprint,value.queryFingerprint);
  assert.match(value.queryFingerprint,/^[0-9a-f]{64}$/); assert.equal(Object.isFrozen(value.positions[0]),true);
  for (const change of [{roomId:'room-b'},{participantCount:4,positions:[position(0)]},
    {startsAt:'2026-10-20T11:00:00.000Z'},{publicationRevision:2},{sourceRevision:2},{configurationRevision:3},
    {positions:[{...position(0),quantity:3},position(1,'package')]}]) {
    assert.notEqual(query({...raw,...change},scope).queryFingerprint,value.queryFingerprint);
  }
  assert.notEqual(query(raw,{...scope,tenantId:id(2)}).queryFingerprint,value.queryFingerprint);
  assert.notEqual(query(raw,{...scope,integrationId:id(4)}).queryFingerprint,value.queryFingerprint);
  raw.positions[0].quantity=99; assert.equal(value.positions[0].quantity,2);
});
test('provider response echoes every exact query position and server freshness caps cannot be extended by provider expiry',()=>{
  const raw=reply(); const value=observation(raw,expected());
  assert.equal(value.validUntil,'2026-10-19T12:05:00.000Z'); assert.equal(value.providerValidUntil,raw.validUntil);
  assert.equal(value.receivedAt,'2026-10-19T12:00:01.000Z'); assert.equal(value.sourceRevision,1);
  assert.equal(value.terms.minimumOrderValue,null); assert.equal(evaluate(raw,current()).available,true);
  const early={...raw,validUntil:'2026-10-19T12:00:30.000Z'};
  assert.equal(observation(early,expected()).validUntil,early.validUntil);
});
test('expiry is exclusive, late receipt cannot refresh old facts and unknown validity is never known availability',()=>{
  const raw=reply(); assert.equal(evaluate(raw,current({now:'2026-10-19T12:04:59.999Z'})).available,true);
  assert.deepEqual(evaluate(raw,current({now:'2026-10-19T12:05:00.000Z'})).reasons,['availability_expired']);
  assert.equal(evaluate(raw,current({receivedAt:'2026-10-19T12:10:00.000Z',now:'2026-10-19T12:10:01.000Z'})).available,false);
  assert.deepEqual(evaluate({...raw,validUntil:null},current()).reasons,['availability_validity_unknown']);
  assert.deepEqual(evaluate(raw,current({now:'2026-10-19T12:00:00.999Z'})).reasons,['availability_time_unverified']);
});
test('new configuration/publication/published source invalidates availability while an unreviewed later receipt has no authority here',()=>{
  for (const change of [{configurationRevision:3},{publicationRevision:2},{publishedSourceRevision:2}]) {
    assert.deepEqual(evaluate(reply(),current(change)).reasons,['availability_basis_changed']);
  }
  assert.equal(evaluate(reply(),current()).available,true);
  assert.throws(()=>evaluate(reply(),current({latestReceivedSourceRevision:2})));
});
test('unavailable and unknown positions remain explicit and are never inferred from missing or partial results',()=>{
  for (const status of ['unavailable','unknown']) {
    const raw=reply(); raw.positions[0].status=status; const value=evaluate(raw,current());
    assert.equal(value.available,false); assert.deepEqual(value.reasons,[status === 'unknown' ? 'availability_unknown' : 'unavailable']);
  }
  for (const positions of [[],[reply().positions[0]],reply().positions.map(()=>reply().positions[0])]) {
    assert.throws(()=>observation({...reply(),positions},expected()));
  }
});
test('responses cannot swap query/position identity, source, quantity, publication, Tenant, price or approval authority',()=>{
  for (const change of [{queryId:id(11)},{tenantId:id(2)},{publicationRevision:2},{providerPrice:{amountMinor:0,currency:'EUR'}},
    {approved:true},{positions:[{...reply().positions[0],quantity:2},reply().positions[1]]},
    {positions:[{positionId:id(999),status:'available'},reply().positions[1]]},
    {positions:[{...reply().positions[0],status:'confirmed'},reply().positions[1]]}]) {
    assert.throws(()=>observation({...reply(),...change},expected()));
  }
});
test('query preserves existing100-direct-plus-one-package capacity, including500 package and1000 item quantities',()=>{
  const raw=input(); raw.participantCount=500; raw.positions=[...Array.from({length:100},(_,n)=>({...position(n),quantity:1000})),
    {...position(200,'package'),quantity:500}];
  assert.equal(query(raw,scope).positions.length,101);
  assert.equal(evaluate(reply(raw),current({query:raw})).available,true);
  raw.positions.push(position(300)); assert.throws(()=>query(raw,scope));
});
test('ambiguous shapes, duplicate source/position identities, invalid variants/quantities and forged timing fail closed',()=>{
  for (const change of [{tenantId:id(2)},{sourceRevision:0},{positions:[]},{positions:Array(1)},
    {positions:[position(0),position(0)]},{positions:[position(0),{...position(0),positionId:id(777)}]},
    {positions:[{...position(0),variantId:'foreign'}]},{positions:[{...position(1,'package'),variantId:null}]},
    {positions:[{...position(1,'package'),quantity:4}]},{positions:[{...position(0),quantity:0}]},
    {positions:[position(1,'package'),position(2,'package')]},{participantCount:501},
    {endsAt:input().startsAt},{startsAt:'2026-02-30T12:00:00.000Z'},{sourceVersion:'unsafe\u0085version'}]) {
    assert.throws(()=>query({...input(),...change},scope));
  }
  for (const change of [{observedAt:'2026-10-19T12:00:02.000Z'},{validUntil:reply().observedAt},
    {availabilityVersion:'<unsafe>'},{terms:{...terms(),minimumLeadTimeMinutes:-1}}]) {
    assert.throws(()=>observation({...reply(),...change},expected()));
  }
  for (const maximumAgeMs of [0,3600001,'300000',null]) assert.throws(()=>observation(reply(),expected({maximumAgeMs})));
});
test('hidden getters and sparse status arrays are rejected without executing input accessors',()=>{
  const raw=reply(); let reads=0; Object.defineProperty(raw,'positions',{enumerable:true,get(){reads++;return [];}});
  assert.throws(()=>observation(raw,expected())); assert.equal(reads,0);
  assert.throws(()=>observation({...reply(),positions:Array(2)},expected()));
  const request=input(); Object.defineProperty(request.positions[0],'quantity',{enumerable:true,get(){reads++;return 1;}});
  assert.throws(()=>query(request,scope)); assert.equal(reads,0);
});
test('results retain factual terms/status only and make no quote, price, publication, reservation or order acknowledgement',()=>{
  const raw=reply(); const value=evaluate(raw,current()); raw.terms.cancelCutoffMinutes=60; raw.positions[0].status='unavailable';
  assert.equal(value.terms.cancelCutoffMinutes,0); assert.equal(value.positions[0].status,'available');
  assert.equal(Object.isFrozen(value.positions),true); assert.equal(Object.isFrozen(value.terms),true);
  assert.doesNotMatch(JSON.stringify(value),/supplierCost|providerPrice|approved|reservationId|orderId|commandId|tenantId|integrationId/);
});
