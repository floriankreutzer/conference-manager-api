import assert from 'node:assert/strict';
import test from 'node:test';
import { protectedRuntimeRoleGrantPlan,grantProtectedRuntimeRoles } from '../scripts/support/protected-runtime-role-grants.mjs';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

const epoch='be000000-0000-4000-8000-000000000001';
test('operator plan preserves per-surface proof custody and offline enrollment without connecting or creating credentials',()=>{
  for (const environment of ['dev','int','prod']) {
    const plan=protectedRuntimeRoleGrantPlan({ environment,securityEpoch: epoch });
    assert.ok(Object.isFrozen(plan));assert.equal(plan.schemaVersion,62);
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
