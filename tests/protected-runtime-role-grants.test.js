import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedRuntimeRoleGrantPlan,grantProtectedRuntimeRoles,platformAuditSegmentRoleGrantPlan,
  grantPlatformAuditSegmentRuntimeRoles,customerMicrosoftGroupRoleGrantPlan,grantCustomerMicrosoftGroupRuntimeRoles,
  platformMicrosoftOperationRoleGrantPlan,grantPlatformMicrosoftOperationRuntimeRoles,syntheticMicrosoftCustodyRoleGrantPlan,
  ownerCustomerCustodyRoleGrantPlan,
  grantOwnerCustomerCustodyRuntimeRoles,platformObservabilityReadRoleGrantPlan,grantPlatformObservabilityReadRuntimeRoles,
  customerRequestWorkflowRoleGrantPlan,grantCustomerRequestWorkflowRuntimeRoles }
  from '../scripts/support/protected-runtime-role-grants.mjs';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const epoch='be000000-0000-4000-8000-000000000001';
test('existing INT Microsoft operation grants are fixed Platform CRUD without Customer or administrative authority',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const plan=platformMicrosoftOperationRoleGrantPlan(input);
  assert.deepEqual(plan.statements,[
    'GRANT SELECT,INSERT,UPDATE,DELETE ON public.platform_microsoft_operation_proofs TO "cm_protected_int_platform"',
  ]);
  assert.ok(Object.isFrozen(plan.statements));let connected=false;
  const pool={ async connect() { connected=true;throw new Error('private-driver-detail'); } };
  for (const invalid of [{ ...input,environment: 'prod' },{ ...input,role: 'customer' },
    { ...input,statements: [] },{ ...input,get securityEpoch() { throw new Error('private-accessor'); } }]) {
    assert.throws(()=>platformMicrosoftOperationRoleGrantPlan(invalid),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
    await assert.rejects(grantPlatformMicrosoftOperationRuntimeRoles(pool,invalid),
      { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  }
  assert.equal(connected,false);
});
test('existing INT request workflow delta grants only the required Customer lifecycle columns',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const plan=customerRequestWorkflowRoleGrantPlan(input);
  assert.deepEqual(plan.statements,[
    'GRANT UPDATE(status,ended_at,request_id,submission_fingerprint) ON public."request_workflow_starts" TO "cm_protected_int_customer"',
  ]);
  assert.ok(Object.isFrozen(plan.statements));
  let connected=false;const pool={ async connect() { connected=true;throw new Error('private-driver-detail'); } };
  for (const invalid of [{ ...input,environment: 'prod' },{ ...input,role: 'platform' },{ ...input,statements: [] },
    { ...input,segmentId: 'private' },{ ...input,get securityEpoch() { throw new Error('private-accessor'); } }]) {
    assert.throws(()=>customerRequestWorkflowRoleGrantPlan(invalid),{ message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
    await assert.rejects(grantCustomerRequestWorkflowRuntimeRoles(pool,invalid),
      { message: 'PROTECTED_RUNTIME_ROLE_INSTALLATION_REFUSED' });
  }
  assert.equal(connected,false);
});
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
    assert.ok(Object.isFrozen(plan));assert.equal(plan.schemaVersion,72);
    const customer=plan.roles[0],platform=plan.roles[1];
    const workflowGrants=customer.statements.filter(sql=>sql.includes('public."request_workflow_starts"'));
    assert.deepEqual(workflowGrants,[
      'GRANT SELECT,INSERT ON public."request_workflow_starts" TO "cm_protected_'+environment+'_customer"',
      'GRANT UPDATE(status,ended_at,request_id,submission_fingerprint) ON public."request_workflow_starts" TO "cm_protected_'+environment+'_customer"',
    ]);
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

test('synthetic Microsoft Customer grant delta exposes only custody predicate columns',()=>{
  const plan=syntheticMicrosoftCustodyRoleGrantPlan({ environment: 'int',securityEpoch: epoch,
    segmentId: 'be000000-0000-4000-8000-000000000002' });
  assert.equal(plan.schemaVersion,72);assert.equal(plan.statements.length,2);
  assert.match(plan.statements[0],/^GRANT SELECT\(id,operator_id,environment,protected_security_epoch,/);
  assert.match(plan.statements[0],/authenticated_at\) ON public.platform_microsoft_operation_proofs TO "cm_protected_int_customer"$/);
  assert.doesNotMatch(plan.statements.join('\n'),/state_hash|browser_hash|nonce_hash|INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE/);
  assert.equal(plan.statements[1],'GRANT SELECT(step_up_expires_at) ON public.platform_sessions TO "cm_protected_int_customer"');
});


test('REAL owner delta grants exact existing-role custody without Platform mutation or Customer identity creation',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const plan=ownerCustomerCustodyRoleGrantPlan(input);assert.equal(plan.schemaVersion,72);
  assert.ok(Object.isFrozen(plan.statements));assert.equal(plan.statements.length,8);
  const customer=plan.statements.filter(value=>value.endsWith('"cm_protected_int_customer"')).join('\n');
  const platform=plan.statements.filter(value=>value.endsWith('"cm_protected_int_platform"')).join('\n');
  assert.match(customer,/GRANT SELECT ON public\."platform_owner_customer_users"/);
  assert.match(customer,/protected_lock_owner_customer_source\(text,uuid,uuid\)/);
  assert.doesNotMatch(customer,/GRANT (?:[^\n]*INSERT|[^\n]*UPDATE|[^\n]*DELETE)[^\n]*ON public\."platform_/);
  assert.match(platform,/GRANT SELECT,INSERT ON public\."platform_owner_customer_users"/);
  assert.match(platform,/GRANT SELECT,UPDATE ON public\."owner_customer_handoffs"/);
  assert.doesNotMatch(plan.statements.join('\n'),/TRUNCATE|CREATE|PASSWORD|GRANT OPTION|nonce_hash|state_hash|token_hash/);
  let connected=false;const pool={ connect() { connected=true;assert.fail(); } };
  for (const patch of [{ environment: 'prod' },{ statements: [] },{ role: 'owner' },{ segmentId: 'private' }]) {
    assert.throws(()=>ownerCustomerCustodyRoleGrantPlan({ ...input,...patch }),/INSTALLATION_REFUSED/);
    await assert.rejects(grantOwnerCustomerCustodyRuntimeRoles(pool,{ ...input,...patch }),/INSTALLATION_REFUSED/);
  }
  assert.equal(connected,false);
});

test('observability delta grants fixed Platform SELECT only and rejects supplied authority before connecting',async()=>{
  const input={ environment: 'int',securityEpoch: epoch,segmentId: 'be000000-0000-4000-8000-000000000002' };
  const names=['platform_runtime_deployments','platform_runtime_tenant_mappings','platform_diagnostic_events',
    'platform_metering_periods','platform_operational_quotas'];
  const plan=platformObservabilityReadRoleGrantPlan(input);
  assert.deepEqual(plan.statements,names.map(name=>`GRANT SELECT ON public."${name}" TO "cm_protected_int_platform"`));
  for (const surface of protectedRuntimeRoleGrantPlan({ environment: 'int',securityEpoch: epoch }).roles) {
    for (const name of names) {
      const grant=surface.statements.find(sql=>sql.includes(`public."${name}" `));
      if (surface.surface==='platform') assert.match(grant,/^GRANT SELECT(?:,INSERT)? ON /);
      else if (name==='platform_diagnostic_events') assert.match(grant,/^GRANT INSERT ON /);
      else assert.equal(grant,undefined);
    }
  }
  let connected=false;const pool={ connect() { connected=true;assert.fail(); } };
  for (const patch of [{ environment: 'prod' },{ role: 'customer' },{ statements: [] },{ segmentId: 'invalid' }]) {
    assert.throws(()=>platformObservabilityReadRoleGrantPlan({ ...input,...patch }),/INSTALLATION_REFUSED/);
    await assert.rejects(grantPlatformObservabilityReadRuntimeRoles(pool,{ ...input,...patch }),/INSTALLATION_REFUSED/);
  }
  assert.equal(connected,false);
});
