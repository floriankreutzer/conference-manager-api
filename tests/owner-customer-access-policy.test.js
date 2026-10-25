import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createOwnerCustomerAccessPolicy } from '../src/platform/identity/owner-customer-access-policy.js';
import { PLATFORM_ROLE,permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const now=Date.parse('2026-10-24T12:00:00.000Z'),instant=value=>new Date(value).toISOString();
const scope={ environment: 'int',securityEpoch: randomUUID(),platformSecurityEpoch: 7,
  customerOrigin: 'https://app.example.test',platformOrigin: 'https://ops.example.test' };
const roles=Object.values(PLATFORM_ROLE).sort(),operatorId=randomUUID();
const selection={ flowId: randomUUID(),operatorId,tenantId: randomUUID(),role: 'tenant_admin' };
const normal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 6,
  providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: randomUUID(),subjectReference: randomUUID() },
  targetScope: { mode: 'all',securityVersion: 6 },
  assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',authenticatedAt: instant(now) },
  session: { id: randomUUID(),issuedAt: instant(now),expiresAt: instant(now+3_600_000),securityVersion: 6,
    securityEpoch: 7,stepUpExpiresAt: null } };
const fresh={ ...normal,assurance: { ...normal.assurance,level: 'step_up',authenticationContext: 'cm:ms:fresh:v1' },
  session: { ...normal.session,id: randomUUID(),stepUpExpiresAt: instant(now+300_000) } };
const policy=createOwnerCustomerAccessPolicy(scope);

test('own REAL target preparation requires every Platform role, all scope and the exact normal Microsoft profile',()=>{
  assert.deepEqual(policy.prepare(normal,selection),normal);
  for (const role of ['employee','conference_manager','tenant_admin']) {
    assert.deepEqual(policy.prepare(normal,{ ...selection,role }),normal);
  }
  for (const patch of [{ operatorId: randomUUID() },{ targetScope: { mode: 'allowlist',securityVersion: 6 } },
    { providerIdentity: { ...normal.providerIdentity,provider: 'demo_platform' } },
    { assurance: { ...normal.assurance,authenticationContext: 'cm:pk:v1' } },
    { assurance: { ...normal.assurance,authenticationContext: 'cm:ms:fresh:v1' } },
    { session: { ...normal.session,securityEpoch: 8 } }]) {
    assert.throws(()=>policy.prepare({ ...normal,...patch },selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
  }
  for (const excluded of roles) {
    const reduced=roles.filter(role=>role!==excluded);
    assert.throws(()=>policy.prepare({ ...normal,roles: reduced,permissions: permissionsForPlatformRoles(reduced) },selection),
      /OWNER_CUSTOMER_ACCESS_DENIED/);
  }
  assert.throws(()=>policy.prepare(fresh,selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
});

test('owner continuation binds independent fresh and normal sessions to the same actual provider, roles, version and auth time',()=>{
  const verified=policy.continuation(fresh,normal,selection);
  assert.deepEqual(verified,{ principal: fresh,continuationPrincipal: normal });assert.ok(Object.isFrozen(verified));
  for (const patch of [{ operatorId: randomUUID() },{ session: { ...normal.session,id: fresh.session.id } },
    { providerIdentity: { ...normal.providerIdentity,tenantReference: randomUUID() } },
    { providerIdentity: { ...normal.providerIdentity,subjectReference: randomUUID() } },
    { assurance: { ...normal.assurance,authenticatedAt: instant(now-1000) } },
    { securityVersion: 7,targetScope: { mode: 'all',securityVersion: 7 },session: { ...normal.session,securityVersion: 7 } }]) {
    assert.throws(()=>policy.continuation(fresh,{ ...normal,...patch },selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
  }
  assert.throws(()=>policy.continuation(normal,normal,selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
  assert.throws(()=>policy.continuation(fresh,fresh,selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
  assert.throws(()=>policy.continuation({ ...fresh,assurance: { ...fresh.assurance,authenticationContext: 'cm:pk:fresh:v1' } },
    normal,selection),/OWNER_CUSTOMER_ACCESS_DENIED/);
});


test('owner-only source preparation retains the same necessary all-role Microsoft checks without inventing a target',()=>{
  assert.deepEqual(policy.owner(normal),normal);
  for (const identity of [fresh,{ ...normal,targetScope: { mode: 'allowlist',securityVersion: 6 } },
    { ...normal,roles: ['platform_security_admin'],permissions: permissionsForPlatformRoles(['platform_security_admin']) },
    { ...normal,assurance: { ...normal.assurance,authenticationContext: 'cm:pk:v1' } }]) {
    assert.throws(()=>policy.owner(identity),/OWNER_CUSTOMER_ACCESS_DENIED/);
  }
});
