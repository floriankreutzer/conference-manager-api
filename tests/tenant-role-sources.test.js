import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTenantElevatedRoles,resolveTenantRoleSources } from '../src/authorization/tenant-role-sources.js';
import { TENANT_ROLE,tenantAuthorizationSnapshot } from '../src/authorization/policy.js';

const manager=TENANT_ROLE.CONFERENCE_MANAGER,admin=TENANT_ROLE.TENANT_ADMIN;
const combinations=[[],[manager],[admin],[manager,admin]].map(Object.freeze);
test('all sixteen direct/group combinations retain exactly the independent role and permission union',()=>{
  for (const directRoles of combinations) for (const microsoftGroupRoles of combinations) {
    const resolved=resolveTenantRoleSources({ directRoles,microsoftGroupRoles });
    const expected=[manager,admin].filter(role=>directRoles.includes(role) || microsoftGroupRoles.includes(role));
    assert.deepEqual(resolved.effectiveRoles,expected);
    assert.deepEqual(tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE,...resolved.effectiveRoles]),
      tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE,...expected]));
    assert.equal(Object.isFrozen(resolved),true);assert.equal(Object.isFrozen(resolved.effectiveRoles),true);
  }
});
test('removing either role source preserves the other; removing both removes the elevated role',()=>{
  for (const role of [manager,admin]) {
    assert.deepEqual(resolveTenantRoleSources({ directRoles: [],microsoftGroupRoles: [role] }).effectiveRoles,[role]);
    assert.deepEqual(resolveTenantRoleSources({ directRoles: [role],microsoftGroupRoles: [] }).effectiveRoles,[role]);
  }
  assert.deepEqual(resolveTenantRoleSources({ directRoles: [],microsoftGroupRoles: [] }).effectiveRoles,[]);
});
test('raw groups, Platform roles, duplicate/unknown roles, sparse arrays and getters cannot create a grant',()=>{
  const values=[undefined,null,'tenant_admin',{},['employee'],['platform_security_admin'],['group-id'],
    [admin,admin],[manager,admin,manager],Array(1)];
  let invoked=false;const getter=[];Object.defineProperty(getter,'0',{ get() { invoked=true;return admin; } });
  values.push(getter);
  for (const value of values) {
    assert.throws(()=>normalizeTenantElevatedRoles(value),{ code: 'TENANT_USER_ROLES_INVALID' });
    assert.throws(()=>resolveTenantRoleSources({ directRoles: [],microsoftGroupRoles: value }));
  }
  assert.equal(invoked,false);
  assert.deepEqual(normalizeTenantElevatedRoles([admin,manager]),[manager,admin]);
});

test('administration projects mapped groups but forwards only direct grants to its persistence port',async()=>{
  const { createTenantUserAdministrationService }=await import('../src/application/tenant-user-administration-service.js');
  const tenantId='10000000-0000-4000-8000-000000000001',userId='10000000-0000-4000-8000-000000000002';
  const user={ tenantId,userId,displayName: 'Mapped member',active: true,elevatedRoles: [],microsoftGroupRoles: [manager] };
  let written;
  const service=createTenantUserAdministrationService({ repository: {
    async listByTenantId() { return [user]; },
    async setElevatedRoles(input) { written=input.elevatedRoles;return { status: 'unchanged',user }; },
  },authorizationPolicy: { requireTenantPermission() {} },auditService: {
    createEvent() {},record() {},recordAuthorizationDenied() {},
  } });
  const context={ principal: { userId: '10000000-0000-4000-8000-000000000003' },tenantContext: { tenantId },
    correlationId: '10000000-0000-4000-8000-000000000004' };
  assert.deepEqual((await service.listUsers(context))[0].roles,[TENANT_ROLE.EMPLOYEE,manager]);
  assert.deepEqual((await service.listUsers(context))[0].roleSources,{ direct: [],microsoftGroups: [manager] });
  assert.deepEqual((await service.setRoles({ ...context,targetUserId: userId,roles: [] })).roles,[TENANT_ROLE.EMPLOYEE,manager]);
  assert.deepEqual(written,[]);
});

test('role presentation preserves every source combination without exposing provider identifiers',async()=>{
  const { tenantUserRolePresentation }=await import('../src/application/tenant-user-role-presentation.js');
  for (const direct of combinations) for (const microsoftGroups of combinations) {
    const output=tenantUserRolePresentation({ elevatedRoles: direct,microsoftGroupRoles: microsoftGroups });
    assert.deepEqual(output.roles,['employee',...[manager,admin].filter(role=>direct.includes(role) || microsoftGroups.includes(role))]);
    if (microsoftGroups.length) {
      assert.deepEqual(output.roleSources,{ direct,microsoftGroups });
      assert.equal(Object.isFrozen(output.roleSources),true);
    } else assert.equal(Object.hasOwn(output,'roleSources'),false);
  }
});

test('source envelope rejects extra authority and accessors before reading values',()=>{
  let invoked=false;
  const value={ directRoles: [] };
  Object.defineProperty(value,'microsoftGroupRoles',{ get() { invoked=true;return [admin]; } });
  assert.throws(()=>resolveTenantRoleSources(value),{ code: 'TENANT_ROLE_SOURCES_INVALID' });
  assert.equal(invoked,false);
  assert.throws(()=>resolveTenantRoleSources({ directRoles: [],microsoftGroupRoles: [],roles: [admin] }));
});
