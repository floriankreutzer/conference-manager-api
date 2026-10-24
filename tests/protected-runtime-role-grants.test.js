import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedRuntimeRoleGrantPlan,grantProtectedRuntimeRoles,platformAuditSegmentRoleGrantPlan,
  grantPlatformAuditSegmentRuntimeRoles,customerMicrosoftGroupRoleGrantPlan,grantCustomerMicrosoftGroupRuntimeRoles }
  from '../scripts/support/protected-runtime-role-grants.mjs';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const epoch='be000000-0000-4000-8000-000000000001';
test('existing INT Microsoft group role delta grants only Customer table authority and refuses caller authority',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const plan=customerMicrosoftGroupRoleGrantPlan(input);
  assert.deepEqual(plan.statements,[
    'GRANT SELECT,INSERT,UPDATE ON public."tenant_microsoft_role_settings" TO "cm_protected_int_customer"',
    'GRANT SELECT,INSERT,DELETE ON public."customer_microsoft_group_observations" TO "cm_protected_int_customer"',
  ]);
  assert.ok(Object.isFrozen(plan));assert.ok(Object.isFrozen(plan.statements));
  let connected=false;const pool={ async connect() { connected=true;throw new Error('private-driver-detail'); } };
  for (const invalid of [{ ...input,environment: 'prod' },{ ...input,role: 'arbitrary' },{ ...input,statements: [] },
    { ...input,segmentId: 'private' },{ ...input,get securityEpoch() { throw new Error('private-accessor'); } }]) {
    assert.throws(()=>customerMicrosoftGroupRoleGrantPlan(invalid),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
    await assert.rejects(grantCustomerMicrosoftGroupRuntimeRoles(pool,invalid),
      { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  }
  assert.equal(connected,false);
});
test('existing INT audit role delta is fixed, minimal and removes legacy writing privileges',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const plan=platformAuditSegmentRoleGrantPlan(input),sql=plan.statements.join('\n');
  assert.equal(plan.statements.length,7);assert.ok(Object.isFrozen(plan.statements));
  assert.match(sql,/REVOKE UPDATE ON public.platform_audit_chain_state/);
  assert.match(sql,/REVOKE INSERT ON public.platform_audit_checkpoints/);
  assert.doesNotMatch(sql,/GRANT (?:INSERT|UPDATE)[^\n]*ON public.platform_audit_segments/);
  assert.doesNotMatch(sql,/TRUNCATE|CREATE|PASSWORD|WITH GRANT OPTION|DEFAULT PRIVILEGES|cm_demo|cm_protected_prod/);
  let connected=false;
  const pool={ async connect() { connected=true;throw new Error('private-driver-detail'); } };
  for (const invalid of [{ ...input,environment: 'prod' },{ ...input,role: 'arbitrary' },{ ...input,segmentId: 'private' },
    { ...input,get securityEpoch() { throw new Error('private-accessor'); } }]) {
    assert.throws(()=>platformAuditSegmentRoleGrantPlan(invalid),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
    await assert.rejects(grantPlatformAuditSegmentRuntimeRoles(pool,invalid),
      { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  }
  assert.equal(connected,false);
});
test('operator plan preserves per-surface proof custody and offline enrollment without connecting or creating credentials',()=>{
  for (const environment of ['dev','int','prod']) {
    const plan=protectedRuntimeRoleGrantPlan({ environment,securityEpoch: epoch });
    assert.ok(Object.isFrozen(plan));assert.equal(plan.schemaVersion,69);
    const customer=plan.roles[0],platform=plan.roles[1];
    assert.equal(customer.role,`cm_protected_${environment}_customer`);
    assert.equal(platform.role,`cm_protected_${environment}_platform`);
    assert.ok(Object.isFrozen(customer.statements));
    const customerSql=customer.statements.join('\n'),platformSql=platform.statements.join('\n');
    assert.doesNotMatch(customerSql,
      /GRANT (?:[^\n]*UPDATE|[^\n]*INSERT|[^\n]*DELETE)[^\n]*ON public\."platform_(?:operators|sessions|audit|passkey|oidc)/);
    assert.doesNotMatch(customerSql,/token_hash|public_key|payload_envelope|CREATE ROLE|PASSWORD|ALL TABLES|DEFAULT PRIVILEGES/);
    assert.match(customerSql,/protected_lock_synthetic_handoff_source/);
    assert.doesNotMatch(platformSql,/GRANT INSERT[^\n]*platform_passkey_enrollment_grants/);
    assert.doesNotMatch(platformSql,/GRANT [^\n]*INSERT[^\n]*ON public\."sessions"/);
    assert.doesNotMatch(platformSql,/payload_envelope|customer_email_challenges|customer_microsoft_flows/);
    assert.doesNotMatch(platformSql,/GRANT [^\n]*(?:UPDATE|DELETE)[^\n]*ON public\."tenant_runtime_registry"/);
    assert.doesNotMatch(customerSql+'\n'+platformSql,/TRUNCATE|REFERENCES|TRIGGER|WITH GRANT OPTION|cm_demo/);
    assert.doesNotMatch(customerSql+'\n'+platformSql,/mark_request_attribution_used|prune_expired_unreferenced_room_media/);
  }
});

test('malformed operator scopes fail before acquiring a database resource and do not reflect supplied detail',async()=>{
  let calls=0;const pool={ query() { calls++; },connect() { calls++; } };
  const invalid=[{},null,{ environment: 'demo',securityEpoch: epoch },{ environment: 'int',securityEpoch: 'PRIVATE_DETAIL' },
    { environment: 'int',securityEpoch: epoch,role: 'owner' },
    { get environment() { throw new Error('GETTER_MUST_NOT_RUN'); },securityEpoch: epoch }];
  for (const value of invalid) {
    assert.throws(()=>protectedRuntimeRoleGrantPlan(value),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
    await assert.rejects(grantProtectedRuntimeRoles(pool,value),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  }
  assert.equal(calls,0);
});

test('runtime and Demo imports cannot reach operator grants even when script files are outside the runtime graph',()=>{
  for (const file of ['src/index.js','src/protected-platform-config.js','src/domain/plan.js','src/http/route.js',
    'src/persistence/postgres/adapter.js','src/demo/customer-main.js']) {
    const depth=file.split('/').length-1,relative='../'.repeat(depth)+'scripts/support/protected-runtime-role-grants.mjs';
    for (const source of [`import '${relative}';`,`export { grantProtectedRuntimeRoles } from '${relative}';`,
      `const load=()=>import('${relative}');`]) {
      const violations=architectureConsolidationBoundaryViolations({ [file]: source });
      assert.ok(violations.some(message=>message.includes('Runtime code must not import operator or build scripts.')));
    }
  }
});
