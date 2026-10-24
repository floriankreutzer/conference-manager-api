import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMicrosoftGroupMappings,resolveMicrosoftMappedGroups } from '../src/authorization/microsoft-group-mapping.js';
import { microsoftGroupObservation } from '../src/identity/microsoft-group-observation.js';
import { createTenantMicrosoftRoleService } from '../src/application/tenant-microsoft-role-service.js';
import { createAuthorizationPolicy } from '../src/authorization/policy.js';
import { createAuditHarness } from './support/audit-harness.js';

const directory='71000000-0000-4000-8000-000000000001',group='71000000-0000-4000-8000-000000000002';
const other='71000000-0000-4000-8000-000000000003',tenant='71000000-0000-4000-8000-000000000004';
const actor='71000000-0000-4000-8000-000000000005',correlationId='71000000-0000-4000-8000-000000000006';
const mappings=[{ groupId: group,roles: ['conference_manager','tenant_admin'] }];
test('only exact approved directory/group intersections grant independent elevated roles',()=>{
  const input={ directoryId: directory,mappings,providerDirectoryId: directory,
    membership: { status: 'complete',groupIds: [group,other] } };
  assert.deepEqual(resolveMicrosoftMappedGroups(input),{ conference_manager: [group],tenant_admin: [group] });
  for (const change of [{ providerDirectoryId: other },{ membership: { status: 'complete',groupIds: [other] } },
    { membership: { status: 'unavailable',groupIds: [] } },{ membership: { status: 'overage',groupIds: [] } }]) {
    assert.deepEqual(resolveMicrosoftMappedGroups({ ...input,...change }),{ conference_manager: [],tenant_admin: [] });
  }
  assert.equal(Object.isFrozen(resolveMicrosoftMappedGroups(input).tenant_admin),true);
});
test('mapping input rejects group names, Platform/baseline roles, duplicates, excess bounds and hidden authority',()=>{
  const getter=[];Object.defineProperty(getter,'0',{ get() { throw new Error('MUST_NOT_INVOKE'); } });
  for (const value of [undefined,null,{},Array(1),getter,[{ groupId: 'Admins',roles: ['tenant_admin'] }],
    [{ groupId: group,roles: ['employee'] }],[{ groupId: group,roles: ['platform_security_admin'] }],
    [{ groupId: group,roles: [] }],[...mappings,...mappings],Array.from({ length: 101 },()=>mappings[0]),
    [{ ...mappings[0],tenantId: tenant }]]) assert.throws(()=>normalizeMicrosoftGroupMappings(value),/INVALID/);
});
test('provider overage URLs are ignored, absent groups are unavailable and complete empty membership revokes',()=>{
  assert.deepEqual(microsoftGroupObservation({}),{ status: 'unavailable',groupIds: [] });
  assert.deepEqual(microsoftGroupObservation({ groups: [] }),{ status: 'complete',groupIds: [] });
  assert.deepEqual(microsoftGroupObservation({ hasgroups: true,groups: [group] }),{ status: 'overage',groupIds: [] });
  assert.deepEqual(microsoftGroupObservation({ _claim_names: { groups: 'src1' },
    _claim_sources: { src1: { endpoint: 'http://127.0.0.1/private' } } }),{ status: 'overage',groupIds: [] });
  for (const groups of [null,{},'Admins',[group,group],[null],Array(1),Array(201).fill(group)]) {
    assert.throws(()=>microsoftGroupObservation({ groups }),/ENTRA_GROUP_CLAIM_INVALID/);
  }
});
function service() {
  const authorizationPolicy=createAuthorizationPolicy(),audit=createAuditHarness({ authorizationPolicy }),calls=[];
  const repository={ async get(input) { calls.push(input);return { revision: 0,directoryId: null,mappings: [] }; },
    async replace(input) { calls.push(input);return { status: 'updated',settings: { revision: 1,directoryId: directory,mappings } }; } };
  return { calls,value: createTenantMicrosoftRoleService({ repository,authorizationPolicy,auditService: audit.service }) };
}
const admin={ userId: actor,tenantId: tenant,roles: ['employee','tenant_admin'],permissions:
  ['request:read','request:cancel','tenant:configure','tenant:users:manage','tenant:integrations:manage','tenant:audit:read'] };
const context={ principal: admin,tenantContext: { tenantId: tenant,status: 'active' },correlationId };
test('mapping administration derives Tenant/actor from authorized context and audits minimized change evidence',async()=>{
  const f=service();await f.value.replace(context,{ directoryId: directory,mappings,expectedRevision: 0 });
  assert.equal(f.calls[0].tenantId,tenant);assert.equal(f.calls[0].actorUserId,actor);
  const event=f.calls[0].auditEventFor({ previousRevision: 0,revision: 1,previousMappingCount: 0,mappingCount: 1 });
  assert.equal(event.action,'tenant.configuration.changed');assert.equal(event.actorUserId,actor);
  assert.deepEqual(event.newState,{ mappingCount: 1,revision: 1 });
  assert.doesNotMatch(JSON.stringify(event),new RegExp(`${group}|${directory}`));
});
test('Employee and foreign-Tenant contexts cannot read or change mappings',async()=>{
  const f=service();
  for (const bad of [{ ...context,tenantContext: { tenantId: other,status: 'active' } },
    { ...context,principal: { ...admin,roles: ['employee'],permissions: ['request:read','request:cancel'] } }]) {
    await assert.rejects(f.value.get(bad));
    await assert.rejects(f.value.replace(bad,{ directoryId: directory,mappings,expectedRevision: 0 }));
  }
  assert.equal(f.calls.length,0);
});
