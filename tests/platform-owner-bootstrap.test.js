import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { normalizePlatformOwnerBootstrapRequest } from '../src/operator/platform-owner-bootstrap-request.js';
import { architectureConsolidationBoundaryViolations } from '../scripts/check-module-boundaries.mjs';
import { normalizePlatformAuditEvent } from '../src/platform/audit/event.js';

const expected={ environment: 'int',deploymentEpoch: randomUUID(),directoryId: randomUUID(),subjectId: randomUUID() };
const request=()=>({ ...expected,approvalReference: 'INT-OWNER-APPROVED',correlationId: randomUUID() });

test('offline bootstrap accepts only exact independently approved identity and deployment without getters or extra authority',()=>{
  const input=request();assert.deepEqual(normalizePlatformOwnerBootstrapRequest(input,expected),input);
  for (const change of [{ environment: 'prod' },{ directoryId: randomUUID() },{ subjectId: randomUUID() },
    { deploymentEpoch: randomUUID() },{ approvalReference: '' },{ approvalReference: 'invalid approval' },
    { roles: ['platform_security_admin'] },{ scopeMode: 'all' },{ correlationId: 'invalid' }]) {
    assert.throws(()=>normalizePlatformOwnerBootstrapRequest({ ...input,...change },expected));
  }
  let invoked=false;
  const getter={ ...input };Object.defineProperty(getter,'directoryId',{ get() { invoked=true;return expected.directoryId; } });
  assert.throws(()=>normalizePlatformOwnerBootstrapRequest(getter,expected));assert.equal(invoked,false);
  assert.throws(()=>normalizePlatformOwnerBootstrapRequest(input,{ ...expected,environment: 'dev' }));
});

test('initial owner audit is an empty-role offline receipt and cannot masquerade as a verified Platform principal',()=>{
  const value={ operatorId: null,roles: [],permissions: [],assuranceLevel: 'offline_owner',targetTenantId: null,
    action: 'platform.operator.changed',targetType: 'platform_operator_bootstrap',targetId: randomUUID(),
    previousState: null,newState: { status: 'active' },occurredAt: new Date().toISOString(),correlationId: randomUUID(),
    outcome: 'success',metadata: { operation: 'first_owner_bootstrap',environment: 'int',deploymentEpoch: expected.deploymentEpoch,
      approvalReference: 'INT-OWNER-APPROVED' },retentionClass: 'recovery' };
  assert.equal(normalizePlatformAuditEvent(value).assuranceLevel,'offline_owner');
  for (const change of [{ operatorId: randomUUID() },{ roles: ['platform_security_admin'] },{ assuranceLevel: 'mfa' },
    { targetType: 'platform_operator' },{ metadata: {} },{ outcome: 'denied' },{ targetTenantId: randomUUID() }]) {
    assert.throws(()=>normalizePlatformAuditEvent({ ...value,...change }));
  }
  assert.doesNotMatch(JSON.stringify(normalizePlatformAuditEvent(value)),new RegExp(expected.subjectId));
});

test('CLI rejects unsupported configuration before network and never reflects private configuration or descriptors',()=>{
  const result=spawnSync(process.execPath,['scripts/platform-owner-bootstrap.mjs'],{
    env: { PATH: process.env.PATH,NODE_ENV: 'test',PLATFORM_OWNER_BOOTSTRAP_SUBJECT_ID: 'private-input' },encoding: 'utf8' });
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'PLATFORM_OWNER_BOOTSTRAP_REFUSED\n');
});

test('HTTP, process roots and both Demo surfaces cannot transitively reach offline owner bootstrap',()=>{
  for (const root of ['src/platform-composition.js','src/protected-platform-runtime.js','src/protected-customer-runtime.js',
    'src/http/bootstrap.js','src/platform/http/bootstrap.js','src/demo/customer-composition.js','src/demo/platform-composition.js']) {
    const depth=root.split('/').length-2;
    const prefix=depth===0 ? './' : '../'.repeat(depth);
    const violations=architectureConsolidationBoundaryViolations({ [root]: `import '${prefix}integrations/offline.js';`,
      'src/integrations/offline.js': "import '../persistence/postgres/platform-owner-bootstrap-repository.js';",
      'src/persistence/postgres/platform-owner-bootstrap-repository.js': 'export const bootstrap=true;' });
    assert.ok(violations.some(value=>value.includes('must not reach offline owner bootstrap')));
  }
});
