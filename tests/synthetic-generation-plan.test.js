import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticGenerationPlanner } from '../src/tenancy/synthetic-generation-plan.js';
import { createSyntheticBusinessTemplates } from '../src/synthetic/business-templates.js';
import { scheduleSyntheticBusinessRequests } from '../src/synthetic/business-schedule.js';
import { DEMO_FIXTURE,createDemoResetGenerationFixture } from '../src/demo/fixture.js';
import { isInternalUuid } from '../src/domain/identifiers.js';

const input={ environment: 'int',operatorId: '80000000-0000-4000-8000-000000000001',
  securityEpoch: '80000000-0000-4000-8000-000000000002',operatorSecurityVersion: 3,now: new Date('2026-10-20T12:00:00Z') };

test('fresh synthetic plans preserve all three business scenarios while remapping every resource and requester',()=>{
  const planner=createSyntheticGenerationPlanner(),first=planner.create(input),second=planner.create(input);
  assert.notEqual(first.generationId,second.generationId);
  assert.deepEqual(first.tenants.map(tenant=>tenant.slot),['northwind','contoso','fabrikam']);
  assert.deepEqual(first.tenants.map(tenant=>tenant.business.requests.length),[20,3,0]);
  const all=new Set([first.generationId,second.generationId]);
  function collect(value) {
    if (!value || typeof value!=='object') return;
    if (Object.hasOwn(value,'id')) { assert.ok(isInternalUuid(value.id));assert.ok(!all.has(value.id));all.add(value.id); }
    for (const item of Object.values(value)) collect(item);
  }
  for (const plan of [first,second]) for (const { business,users,mediaSources } of plan.tenants) {
    collect(business);
    for (const user of users) {
      assert.ok(isInternalUuid(user.userId));assert.ok(!all.has(user.userId));all.add(user.userId);
      assert.equal(user.tenantId,business.id);assert.equal(Object.hasOwn(user,'providerIdentity'),false);
      assert.ok(user.roles.includes('employee'));assert.ok(!user.roles.some(role=>role.startsWith('platform')));
    }
    const employee=users.find(user=>user.role==='employee');
    const rooms=business.settings.locations.flatMap(location=>location.rooms);
    for (const request of business.requests) {
      assert.equal(request.requesterUserId,employee.userId);assert.ok(rooms.some(room=>room.id===request.roomId));
      assert.ok(request.equipmentIds.every(id=>business.settings.catalogue.equipment.some(item=>item.id===id)));
      assert.ok(request.costCenterId===null || business.costCenters.some(item=>item.id===request.costCenterId));
      assert.ok(request.cateringPackageId===null || business.settings.catalogue.cateringPackages
        .some(item=>item.id===request.cateringPackageId));
    }
    for (const media of mediaSources) {
      assert.notEqual(media.assetId,media.sourceAssetId);
      assert.ok([...business.roomMedia,...business.catalogueMedia].some(item=>item.id===media.assetId));
    }
    for (const location of business.settings.locations) for (const room of location.rooms) {
      assert.ok(room.equipment.every(id=>business.settings.catalogue.equipment.some(item=>item.id===id)));
    }
  }
  const originals=createSyntheticBusinessTemplates();
  for (let index=0;index<3;index++) {
    const a=first.tenants[index].business,b=originals[index];
    assert.equal(a.displayName,b.displayName);assert.equal(a.lifecycleStatus,b.lifecycleStatus);
    assert.deepEqual(a.requests.map(r=>[r.title,r.status,r.description]),b.requests.map(r=>[r.title,r.status,r.description]));
    assert.deepEqual(a.roomMedia.map(m=>[m.sha256,m.byteLength]),b.roomMedia.map(m=>[m.sha256,m.byteLength]));
    assert.deepEqual(a.settings.catalogue.equipment.map(e=>e.price),b.settings.catalogue.equipment.map(e=>e.price));
  }
});

test('shared schedule preserves existing Demo dates through Berlin/Paris DST without mutating source',()=>{
  for (const [date,expectedStart] of [['2026-10-20T12:00:00Z','2026-10-27T08:00:00.000Z'],
    ['2026-03-23T12:00:00Z','2026-03-31T07:00:00.000Z'],['2026-10-26T12:00:00Z','2026-11-03T08:00:00.000Z']]) {
    const now=new Date(date),before=JSON.stringify(DEMO_FIXTURE);
    const expected=createDemoResetGenerationFixture(DEMO_FIXTURE,now);
    const actual=scheduleSyntheticBusinessRequests(createSyntheticBusinessTemplates(),now);
    assert.deepEqual(actual.map(t=>t.requests),expected.tenants.map(t=>t.requests));
    const first=actual[0].requests[0];
    assert.equal(first.startsAt,expectedStart);
    assert.equal(new Intl.DateTimeFormat('en-GB',{ timeZone: 'Europe/Berlin',hour: '2-digit',minute: '2-digit',
      hourCycle: 'h23' }).format(new Date(first.startsAt)),'09:00');
    assert.equal(Date.parse(first.endsAt)-Date.parse(first.startsAt),7_200_000);
    assert.ok(Date.parse(first.startsAt)>now.getTime());assert.equal(JSON.stringify(DEMO_FIXTURE),before);
  }
});

test('plans reject production, malformed/extra authority and allocator collision without retry',()=>{
  const planner=createSyntheticGenerationPlanner();
  for (const patch of [{ environment: 'prod' },{ environment: 'demo' },{ operatorId: 'unknown' },
    { securityEpoch: null },{ operatorSecurityVersion: 0 },{ operatorSecurityVersion: 1.5 },
    { now: new Date('invalid') },{ tenantId: input.operatorId },{ roles: ['platform_admin'] }]) {
    assert.throws(()=>planner.create({ ...input,...patch }),/SYNTHETIC_GENERATION_PLAN_INVALID/);
  }
  for (const value of [input.operatorId,input.securityEpoch,DEMO_FIXTURE.tenants[0].id,'unknown']) {
    let calls=0;
    assert.throws(()=>createSyntheticGenerationPlanner({ allocateId: ()=>{ calls++;return value; } }).create(input),
      /SYNTHETIC_GENERATION_PLAN_INVALID/);
    assert.equal(calls,1);
  }
  let calls=0;
  assert.throws(()=>createSyntheticGenerationPlanner({ allocateId: ()=>{
    calls++;return '90000000-0000-4000-8000-000000000001';
  } }).create(input),/SYNTHETIC_GENERATION_PLAN_INVALID/);
  assert.equal(calls,2);
});
