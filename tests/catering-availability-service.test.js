import assert from 'node:assert/strict';
import test from 'node:test';
import { createCateringAvailabilityService } from '../src/application/catering-availability-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { cateringAvailabilityQueryIntent,normalizeCateringAvailabilityObservation,
  normalizeCateringAvailabilityManualReceiptCommand,normalizeCateringAvailabilityRequestCommand,
  normalizeCateringAvailabilityQuery } from '../src/domain/catering-availability.js';
import { createAuditHarness } from './support/audit-harness.js';
const id=n=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const time='2026-10-19T12:00:01.000Z';
const context=(manager=false)=>({principal:{tenantId:id(1),userId:id(20),roles:[manager ? 'conference_manager' : 'employee'],
  permissions:[manager ? 'request:manage' : 'request:read'],session:{id:id(40),securityVersion:1}},
  tenantContext:{tenantId:id(1),status:'active'},correlationId:id(90),requestId:'request-a',queryId:id(10)});
const configuration=()=>({initialOrderMode:'manager_review',
  capabilities:{'catering.catalogue':'manual','catering.availability':'manual'}});
const query=()=>({schemaVersion:1,queryId:id(10),configurationRevision:2,publicationRevision:1,sourceRevision:1,sourceVersion:null,
  siteId:'site-a',roomId:'room-a',startsAt:'2026-10-20T12:00:00.000Z',endsAt:'2026-10-20T13:00:00.000Z',participantCount:3,
  dietaryRequirements:null,specialRequirements:null,
  positions:[{positionId:id(100),kind:'item',sourceId:'supplier-coffee',variantId:null,quantity:2}]});
const scope=()=>({tenantId:id(1),integrationId:id(3),requestId:'request-a',requestVersion:1});
const state=()=>({...scope(),providerId:'synthetic_caterer',configuration:configuration(),connectionAvailable:true,query:query()});
const observation=()=>({schemaVersion:1,queryId:id(10),availabilityVersion:'synthetic-1',observedAt:'2026-10-19T12:00:00.000Z',
  validUntil:'2026-10-19T12:30:00.000Z',positions:[{positionId:id(100),status:'available'}],
  terms:{minimumLeadTimeMinutes:120,minimumOrderValue:null,changeCutoffMinutes:null,cancelCutoffMinutes:null}});
const command=()=>({schemaVersion:1,commandId:id(50),expectedRequestVersion:1,expectedRevision:0});
const receiveCommand=()=>({schemaVersion:1,commandId:id(51),expectedRoundRevision:1,
  attestReceivedFromSupplier:true,observation:observation()});
function fixture({replayed=false,status=null,kind='ROUND_CONFLICT',changeState=v=>v,changeReceipt=v=>v,
  skipFactories=false,storedAge=300000,maximumAgeMs=300000,availableMode='manual'}={}) {
  const authorizationPolicy=createAuthorizationPolicy(); const audit=createAuditHarness({authorizationPolicy}); const calls=[];
  const registry={get:()=>({id:'synthetic_caterer',runtime:'demo',
    capabilities:{...configuration().capabilities,'catering.availability':availableMode}})};
  const repository={
    async request(input) {
      calls.push(input); if (status) return {status,...(status === 'conflict' ? {kind} : {})};
      if (!replayed && !skipFactories) {
        input.queryFor(changeState(state()));
        audit.events.push(input.auditEventFor({availabilityRevision:1,roundRevision:1,recordedAt:time}));
      }
      return {status:'requested',replayed,receipt:changeReceipt({tenantId:input.tenantId,requestId:input.requestId,requestVersion:1,
        actorUserId:input.actorUserId,actorSecurityVersion:input.expectedSecurityVersion,command:input.command,
        availabilityRevision:1,roundRevision:1,queries:[{integrationId:id(3),query:query(),maximumAgeMs:storedAge}],recordedAt:time})};
    },
    async receive(input) {
      calls.push(input); if (status) return {status,...(status === 'conflict' ? {kind} : {})};
      const maximumAgeMs=Math.min(storedAge,input.maximumAgeMs);
      let normalized;
      if (replayed || skipFactories) normalized=normalizeCateringAvailabilityObservation(input.command.observation,
        {...scope(),query:query(),receivedAt:time,maximumAgeMs});
      if (!replayed && !skipFactories) {
        normalized=input.observationFor(changeState({...state(),receivedAt:time,maximumAgeMs:storedAge,
          currentRequestVersion:1,configurationRevision:2,publicationRevision:1,publishedSourceRevision:1,roundRevision:1})).observation;
        audit.events.push(input.auditEventFor({requestId:'request-a',requestVersion:1,previousRevision:1,
          availabilityRevision:2,roundRevision:1,recordedAt:time}));
      }
      return {status:'recorded',replayed,receipt:changeReceipt({tenantId:input.tenantId,integrationId:id(3),queryId:input.queryId,
        requestId:'request-a',requestVersion:1,actorUserId:input.actorUserId,actorSecurityVersion:input.expectedSecurityVersion,
        command:input.command,availabilityRevision:2,roundRevision:1,query:query(),queryMaximumAgeMs:storedAge,
        maximumAgeMs,observation:normalized,recordedAt:time})};
    },
  };
  return {calls,audit,service:createCateringAvailabilityService({repository,registry,authorizationPolicy,auditService:audit.service,
    maximumAgeMs})};
}
test('Employee query uses own Request scope; Manager uses Tenant scope and minimized acknowledgements/audits',async()=>{
  for (const manager of [false,true]) {
    const f=fixture(); const result=await f.service.request({...context(manager),command:command()});
    assert.deepEqual(result,{schemaVersion:1,commandId:id(50),replayed:false,requestId:'request-a',requestVersion:1,
      availabilityRevision:1,roundRevision:1,queryCount:1,recordedAt:time});
    assert.equal(f.calls[0].requesterUserId,manager ? null : id(20)); assert.equal(f.calls[0].sessionId,id(40));
    assert.equal(f.calls[0].expectedSecurityVersion,1); assert.equal(f.audit.events[0].action,'catering.availability.requested');
    assert.doesNotMatch(JSON.stringify(result),/available|supplier|tenantId|integrationId|actor|session|queryId/);
    assert.doesNotMatch(JSON.stringify(f.audit.events),/supplier-coffee|dietary|synthetic-1|sourceRevision|sessionId/);
  }
});
test('manual receipt requires Manager attestation and captured freshness cannot be extended by a relaxed current policy',async()=>{
  const f=fixture({storedAge:60000,maximumAgeMs:300000});
  const result=await f.service.receive({...context(true),command:receiveCommand()});
  assert.equal(result.availabilityRevision,2); assert.equal(result.roundRevision,1);
  assert.equal(f.audit.events[0].action,'catering.availability.received');
  assert.deepEqual(f.audit.events[0].metadata,{operation:'catering_availability_receive',source:'manual'});
  assert.doesNotMatch(JSON.stringify(result),/available|positions|terms|tenantId|integrationId|actor|session/);
});
test('exact historical replay invokes no planners or audit factories and grants no current availability',async()=>{
  const f=fixture({replayed:true,changeState(){throw new Error('MUST_NOT_REPLAN');}});
  assert.equal((await f.service.request({...context(),command:command()})).replayed,true);
  assert.equal((await f.service.receive({...context(true),command:receiveCommand()})).replayed,true);
  assert.equal(f.calls.length,2); assert.equal(f.audit.events.length,0);
});
test('technical roles, catalogue-only Manager, foreign Tenant and absent/stale session cannot invoke ports',async()=>{
  for (const change of [
    {roles:['tenant_admin'],permissions:['tenant:configure']},
    {roles:['conference_manager'],permissions:['tenant:catalogue:manage']},
    {roles:['platform_admin'],permissions:['request:read']},{tenantId:id(9)},
    {session:null},{session:{id:id(40),securityVersion:0}},
  ]) {
    const f=fixture();
    await assert.rejects(f.service.request({...context(),principal:{...context().principal,...change},command:command()}));
    assert.equal(f.calls.length,0);
  }
  const f=fixture(); await assert.rejects(f.service.receive({...context(),command:receiveCommand()})); assert.equal(f.calls.length,0);
});
test('stale request, configuration, publication, source or query round cannot admit a manual observation',async()=>{
  for (const [key,value,kind] of [['currentRequestVersion',2,'REQUEST'],['configurationRevision',3,'CONFIGURATION'],
    ['publicationRevision',2,'PUBLICATION'],['publishedSourceRevision',2,'SOURCE'],['roundRevision',2,'ROUND']]) {
    const f=fixture({changeState:state=>({...state,[key]:value})});
    await assert.rejects(f.service.receive({...context(true),command:receiveCommand()}),
      error=>error.code === `CATERING_AVAILABILITY_${kind}_CONFLICT`);
    assert.equal(f.audit.events.length,0); assert.equal(f.calls.length,1);
  }
});
test('unsupported or disconnected source and API capability cannot silently become a manual receipt',async()=>{
  for (const change of [{connectionAvailable:false},{configuration:{...configuration(),capabilities:{}}}]) {
    const f=fixture({changeState:v=>({...v,...change})});
    await assert.rejects(f.service.request({...context(),command:command()}),/SOURCE_UNAVAILABLE/);
    assert.equal(f.audit.events.length,0);
  }
  const f=fixture({availableMode:'api',changeState:v=>({...v,configuration:{...configuration(),
    capabilities:{...configuration().capabilities,'catering.availability':'api'}}})});
  await assert.rejects(f.service.receive({...context(true),command:receiveCommand()}),/SOURCE_UNAVAILABLE/);
  assert.equal(f.audit.events.length,0);
});
test('closed commands reject forged authority, missing attestation, wrong query and invalid counters before persistence',async()=>{
  for (const change of [{tenantId:id(9)},{expectedRevision:-1},{expectedRequestVersion:0},{expectedRevision:Number.MAX_SAFE_INTEGER}]) {
    const f=fixture(); await assert.rejects(f.service.request({...context(),command:{...command(),...change}}),/INPUT_INVALID/);
    assert.equal(f.calls.length,0);
  }
  for (const change of [{attestReceivedFromSupplier:false},{expectedRoundRevision:0},{approved:true},
    {observation:{...observation(),queryId:id(11)}}]) {
    const f=fixture(); await assert.rejects(f.service.receive({...context(true),command:{...receiveCommand(),...change}}),/INPUT_INVALID/);
    assert.equal(f.calls.length,0);
  }
});
test('corrupt private actor, Tenant, command, counters and receipt clocks cannot yield acknowledgements, including on replay',async()=>{
  for (const change of [{tenantId:id(9)},{actorUserId:id(9)},{actorSecurityVersion:2},{recordedAt:'invalid'},
    {command:{...command(),commandId:id(99)}},{availabilityRevision:0},{roundRevision:0},{credential:'forbidden'}]) {
    const f=fixture({replayed:true,changeReceipt:v=>({...v,...change})});
    await assert.rejects(f.service.request({...context(),command:command()}));
  }
  for (const change of [{tenantId:id(9)},{actorUserId:id(9)},{actorSecurityVersion:2},{recordedAt:'invalid'},
    {command:{...receiveCommand(),commandId:id(99)}},{availabilityRevision:0},{roundRevision:2},
    {maximumAgeMs:600001},{observation:{...observation(),approved:true}}]) {
    const f=fixture({replayed:true,changeReceipt:v=>({...v,...change})});
    await assert.rejects(f.service.receive({...context(true),command:receiveCommand()}));
  }
});
test('successful port claims without actual factories and exact generated queries/observations are rejected',async()=>{
  for (const method of ['request','receive']) {
    const f=fixture({skipFactories:true});
    await assert.rejects(f.service[method]({...context(method === 'receive'),command:method === 'request' ? command() : receiveCommand()}));
  }
  const f=fixture({changeReceipt:v=>({...v,queries:[{integrationId:id(3),query:{...query(),roomId:'foreign'},maximumAgeMs:300000}]})});
  await assert.rejects(f.service.request({...context(),command:command()}));
});
test('repository conflicts and revoked object authority fail closed once, without retries or successful audit',async()=>{
  for (const method of ['request','receive']) for (const status of ['conflict','not_authorized','not_found']) {
    const f=fixture({status});
    await assert.rejects(f.service[method]({...context(method === 'receive'),command:method === 'request' ? command() : receiveCommand()}),
      error=>status === 'conflict' ? error.code === 'CATERING_AVAILABILITY_ROUND_CONFLICT'
        : status === 'not_found' ? error.code === 'RESOURCE_NOT_AVAILABLE' && error.conceal === true
          : error.code === 'PRINCIPAL_NOT_AUTHORIZED');
    assert.equal(f.calls.length,1); assert.equal(f.audit.events.some(v=>v.outcome === 'success'),false);
  }
});
test('query projection removes private ownership/fingerprint and checks integrity before exposing a supplier payload',()=>{
  const normalized=normalizeCateringAvailabilityQuery(query(),scope()); const projected=cateringAvailabilityQueryIntent(normalized);
  assert.deepEqual(projected,query()); assert.equal(Object.isFrozen(projected.positions),true);
  assert.doesNotMatch(JSON.stringify(projected),/tenantId|integrationId|requestId|requestVersion|queryFingerprint/);
  assert.throws(()=>cateringAvailabilityQueryIntent({...normalized,queryFingerprint:'0'.repeat(64)}));
  assert.throws(()=>cateringAvailabilityQueryIntent({...normalized,tenantId:id(9)}));
});
test('manual observation replay intent canonicalizes order, Unicode and UTC independently of receipt time',()=>{
  const raw=receiveCommand(); raw.observation.availabilityVersion='  synthe\u0301tic  ';
  raw.observation.positions.push({positionId:id(101),status:'unknown'});
  const first=normalizeCateringAvailabilityManualReceiptCommand(raw,id(10));
  const other=structuredClone(raw); other.observation.positions.reverse(); other.observation.observedAt='2026-10-19T12:00:00Z';
  assert.deepEqual(normalizeCateringAvailabilityManualReceiptCommand(other,id(10)),first);
  assert.equal(first.observation.availabilityVersion,'synthétic');
  assert.equal(Object.isFrozen(first.observation.positions[0]),true);
  assert.throws(()=>normalizeCateringAvailabilityRequestCommand({...command(),expectedRevision:Number.MAX_SAFE_INTEGER-1}));
});

test('foreign private source scope, incomplete response and corrupt server clock cannot produce an admission audit',async()=>{
  for (const change of [{tenantId:id(9)},{receivedAt:'invalid'},{query:{...query(),queryId:id(11)}}]) {
    const f=fixture({changeState:v=>({...v,...change})});
    await assert.rejects(f.service.receive({...context(true),command:receiveCommand()}),/RESULT_INVALID/);
    assert.equal(f.audit.events.length,0);
  }
  const f=fixture(); const raw=receiveCommand(); raw.observation.positions[0].positionId=id(999);
  await assert.rejects(f.service.receive({...context(true),command:raw}),/INPUT_INVALID/);
  assert.equal(f.audit.events.length,0);
});
test('private receipt cannot relax the exact age chosen by the observation factory even when provider expiry is earlier',async()=>{
  const f=fixture({storedAge:600000,maximumAgeMs:300000,changeReceipt:v=>({...v,maximumAgeMs:400000})});
  const raw=receiveCommand(); raw.observation.validUntil='2026-10-19T12:00:30.000Z';
  await assert.rejects(f.service.receive({...context(true),command:raw}),/RESULT_INVALID/);
});
test('closed command and response-intent schemas reject accessors without invoking them',async()=>{
  let reads=0; const raw=command();
  Object.defineProperty(raw,'expectedRevision',{enumerable:true,get(){reads++;return 0;}});
  const f=fixture(); await assert.rejects(f.service.request({...context(),command:raw}),/INPUT_INVALID/);
  const received=receiveCommand();
  Object.defineProperty(received.observation,'positions',{enumerable:true,get(){reads++;return [];}});
  await assert.rejects(f.service.receive({...context(true),command:received}),/INPUT_INVALID/);
  assert.equal(reads,0); assert.equal(f.calls.length,0);
});
