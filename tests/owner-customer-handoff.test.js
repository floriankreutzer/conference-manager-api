import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { normalizeOwnerCustomerAccessScope,normalizeOwnerCustomerAccessSelection,normalizeOwnerCustomerAccessIntent,
  ownerCustomerAccessOperationHash,ownerCustomerUserId,ownerCustomerAccessIdentityReference,ownerCustomerAccessRedirect,
  requireOwnerCustomerAccessRedirect }
  from '../src/domain/owner-customer-handoff.js';

const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://app.example.test',platformOrigin: 'https://ops.example.test' };
const selection={ flowId: randomUUID(),operatorId: randomUUID(),tenantId: randomUUID(),role: 'tenant_admin' };
const state=Buffer.alloc(32,1).toString('base64url'),code=Buffer.alloc(32,2).toString('base64url');
const binding={ flowId: selection.flowId,stateHash: 'a'.repeat(64),browserVerifier: 'b'.repeat(64) };

test('owner Customer selection is closed, immutable and distinct from synthetic personas or Customer identity authority',()=>{
  assert.ok(Object.isFrozen(normalizeOwnerCustomerAccessScope(scope)));
  for (const role of ['employee','conference_manager','tenant_admin']) {
    assert.deepEqual(normalizeOwnerCustomerAccessIntent({ ...selection,state,role }),{ ...selection,state,role });
  }
  for (const extra of [{ roles: ['tenant_admin'] },{ userId: randomUUID() },{ generationId: randomUUID() },{ mode: 'synthetic' }]) {
    assert.throws(()=>normalizeOwnerCustomerAccessSelection({ ...selection,...extra }),/INPUT_INVALID/);
  }
  for (const role of ['owner','platform_security_admin','guest',null]) {
    assert.throws(()=>normalizeOwnerCustomerAccessSelection({ ...selection,role }),/INPUT_INVALID/);
  }
  const accessor=Object.defineProperty({ ...selection },'role',{ enumerable: true,get() { assert.fail('NO_GETTER'); } });
  assert.throws(()=>normalizeOwnerCustomerAccessSelection(accessor),/INPUT_INVALID/);
  assert.match(ownerCustomerAccessIdentityReference({ flowId: selection.flowId,operatorId: selection.operatorId,role: selection.role }),
    new RegExp(`^${selection.flowId}:${selection.operatorId}:tenant_admin$`));
});

test('exact owner digest binds deployment, epochs, both surfaces, actual operator, target, role and original-browser MACs',()=>{
  const hash=ownerCustomerAccessOperationHash(scope,selection,binding);assert.match(hash,/^[a-f0-9]{64}$/);
  for (const patch of [{ environment: 'dev' },{ securityEpoch: randomUUID() },{ platformSecurityEpoch: 8 },
    { customerOrigin: 'https://other.example.test' },{ platformOrigin: 'https://other.example.test' }]) {
    assert.notEqual(ownerCustomerAccessOperationHash({ ...scope,...patch },selection,binding),hash);
  }
  for (const patch of [{ operatorId: randomUUID() },{ tenantId: randomUUID() },{ role: 'employee' }]) {
    assert.notEqual(ownerCustomerAccessOperationHash(scope,{ ...selection,...patch },binding),hash);
  }
  for (const patch of [{ stateHash: 'c'.repeat(64) },{ browserVerifier: 'c'.repeat(64) }]) {
    assert.notEqual(ownerCustomerAccessOperationHash(scope,selection,{ ...binding,...patch }),hash);
  }
  assert.throws(()=>ownerCustomerAccessOperationHash(scope,selection,{ ...binding,flowId: randomUUID() }),/INPUT_INVALID/);
  for (const patch of [{ environment: 'demo' },{ platformSecurityEpoch: 0 },{ platformSecurityEpoch: '7' },
    { customerOrigin: scope.platformOrigin },{ customerOrigin: 'http://app.example.test' },{ customerOrigin: scope.customerOrigin+'/' }]) {
    assert.throws(()=>normalizeOwnerCustomerAccessScope({ ...scope,...patch }),/INPUT_INVALID/);
  }
});

test('owner browser continuation has one exact same-customer callback and cannot become an open or synthetic redirect',()=>{
  const url=ownerCustomerAccessRedirect(scope,{ state,code });
  assert.equal(requireOwnerCustomerAccessRedirect(scope,url,state),url);
  for (const changed of [url.replace('/owner/','/delegation/'),url+'&role=tenant_admin',url+'#token',
    url.replace('app.example.test','evil.example.test'),url.replace(code,state)]) {
    if (changed===url.replace(code,state)) assert.equal(requireOwnerCustomerAccessRedirect(scope,changed,state),changed);
    else assert.throws(()=>requireOwnerCustomerAccessRedirect(scope,changed,state),/INPUT_INVALID/);
  }
  assert.throws(()=>requireOwnerCustomerAccessRedirect(scope,url,code),/INPUT_INVALID/);
});

test('actual owner has one stable own Customer identifier across selected roles, separated by tenant, owner and environment',()=>{
  const value={ environment: scope.environment,operatorId: selection.operatorId,tenantId: selection.tenantId };
  const own=ownerCustomerUserId(value);assert.match(own,/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(ownerCustomerUserId({ ...value,operatorId: value.operatorId.toUpperCase() }),own);
  for (const patch of [{ tenantId: randomUUID() },{ operatorId: randomUUID() },{ environment: 'prod' }]) {
    assert.notEqual(ownerCustomerUserId({ ...value,...patch }),own);
  }
  assert.throws(()=>ownerCustomerUserId({ ...value,userId: randomUUID() }),/INPUT_INVALID/);
  assert.throws(()=>ownerCustomerUserId({ ...value,role: 'tenant_admin' }),/INPUT_INVALID/);
});
