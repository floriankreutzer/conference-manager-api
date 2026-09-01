import assert from 'node:assert/strict';
import test from 'node:test';
import { createTenantLocationAdministrationService } from '../src/application/tenant-location-administration-service.js';
import { AuthorizationDeniedError } from '../src/authorization/errors.js';
import {
  PERMISSION,
  TENANT_ROLE,
  createAuthorizationPolicy,
  tenantAuthorizationSnapshot,
} from '../src/authorization/policy.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const CORRELATION_ID = '44444444-4444-4444-8444-444444444444';

function principal(elevatedRoles = [], tenantId = TENANT_A) {
  const snapshot = tenantAuthorizationSnapshot([
    TENANT_ROLE.EMPLOYEE,
    ...elevatedRoles,
  ]);
  return Object.freeze({
    tenantId,
    userId: USER_ID,
    ...snapshot,
  });
}

function configuration() {
  return {
    sites: [{
      id: 'berlin',
      name: 'Berlin',
      active: true,
      timeZone: 'Europe/Berlin',
      address: {
        line1: 'Example 1',
        line2: null,
        postalCode: '10115',
        city: 'Berlin',
        countryCode: 'DE',
      },
    }],
    rooms: [{
      id: 'room-1',
      siteId: 'berlin',
      name: 'Room 1',
      capacity: 12,
      active: true,
      floor: '1',
      equipment: ['display'],
      accessibility: [],
      serviceIds: [],
      cateringPackageIds: [],
      floorplanAssetId: null,
      mediaAssetIds: [],
    }],
  };
}

function locationRuntime() {
  const mutations = [];
  const authorizationPolicy = createAuthorizationPolicy();
  const current = configuration();
  const repository = {
    async current(tenantId) {
      assert.equal(tenantId, TENANT_A);
      return { revision: 1, configuration: current, providerContext: [] };
    },
    async update(args) {
      args.assertAuthorizedTransition(current, args.configuration);
      mutations.push(args);
      return {
        revision: args.nextRevision,
        configuration: args.configuration,
        providerContext: [],
      };
    },
    async history() { return []; },
    async revision() { return null; },
    async rollback() { throw new Error('rollback not expected'); },
  };
  const denied = [];
  const auditService = {
    createEvent(event) { return { id: 'audit-event', ...event }; },
    async recordAuthorizationDenied(event) { denied.push(event); },
  };
  const service = createTenantLocationAdministrationService({
    repository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-09-01T06:00:00.000Z'),
  });
  return { service, mutations, denied };
}

function updateLocation(service, actor, proposed) {
  return service.update({
    principal: actor,
    tenantContext: { tenantId: TENANT_A, status: 'active' },
    correlationId: CORRELATION_ID,
    schemaVersion: 1,
    expectedRevision: 1,
    configuration: proposed,
  });
}

test('canonical role matrix keeps Employee baseline and independent elevated permissions', () => {
  const employee = principal();
  const manager = principal([TENANT_ROLE.CONFERENCE_MANAGER]);
  const admin = principal([TENANT_ROLE.TENANT_ADMIN]);
  const dual = principal([TENANT_ROLE.CONFERENCE_MANAGER, TENANT_ROLE.TENANT_ADMIN]);

  assert.deepEqual(employee.roles, [TENANT_ROLE.EMPLOYEE]);
  assert.deepEqual(employee.permissions, [PERMISSION.REQUEST_READ, PERMISSION.REQUEST_CANCEL]);

  assert.deepEqual(manager.roles, [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.CONFERENCE_MANAGER]);
  assert.equal(manager.permissions.includes(PERMISSION.REQUEST_CANCEL), true);
  assert.equal(manager.permissions.includes(PERMISSION.REQUEST_MANAGE), true);
  assert.equal(manager.permissions.includes(PERMISSION.TENANT_ROOMS_BUSINESS_MANAGE), true);
  assert.equal(manager.permissions.includes(PERMISSION.TENANT_CATALOGUE_MANAGE), true);
  assert.equal(manager.permissions.includes(PERMISSION.TENANT_CONFIGURE), false);

  assert.deepEqual(admin.roles, [TENANT_ROLE.EMPLOYEE, TENANT_ROLE.TENANT_ADMIN]);
  assert.equal(admin.permissions.includes(PERMISSION.REQUEST_CANCEL), true);
  assert.equal(admin.permissions.includes(PERMISSION.REQUEST_MANAGE), false);
  assert.equal(admin.permissions.includes(PERMISSION.TENANT_CATALOGUE_MANAGE), false);
  assert.equal(admin.permissions.includes(PERMISSION.TENANT_CONFIGURE), true);
  assert.equal(admin.permissions.includes(PERMISSION.TENANT_USERS_MANAGE), true);
  assert.equal(admin.permissions.includes(PERMISSION.TENANT_INTEGRATIONS_MANAGE), true);
  assert.equal(admin.permissions.includes(PERMISSION.TENANT_AUDIT_READ), true);

  assert.deepEqual(dual.roles, [
    TENANT_ROLE.EMPLOYEE,
    TENANT_ROLE.CONFERENCE_MANAGER,
    TENANT_ROLE.TENANT_ADMIN,
  ]);
  for (const permission of Object.values(PERMISSION)) {
    assert.equal(dual.permissions.includes(permission), true, permission);
  }
});

test('unknown roles and permissions fail closed', () => {
  const policy = createAuthorizationPolicy();
  assert.throws(
    () => tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE, 'unknown_role']),
    AuthorizationDeniedError,
  );
  assert.throws(
    () => policy.assertRecognizedPrincipal({
      ...principal(),
      permissions: [...principal().permissions, 'tenant:unknown'],
    }),
    AuthorizationDeniedError,
  );
});

test('Tenant Admin and Conference Manager permissions do not imply each other', () => {
  const policy = createAuthorizationPolicy();
  const tenantContext = { tenantId: TENANT_A, status: 'active' };
  const manager = principal([TENANT_ROLE.CONFERENCE_MANAGER]);
  const admin = principal([TENANT_ROLE.TENANT_ADMIN]);
  const dual = principal([TENANT_ROLE.CONFERENCE_MANAGER, TENANT_ROLE.TENANT_ADMIN]);

  assert.throws(
    () => policy.requireTenantPermission(manager, tenantContext, PERMISSION.TENANT_CONFIGURE),
    AuthorizationDeniedError,
  );
  assert.throws(
    () => policy.requireTenantPermission(admin, tenantContext, PERMISSION.TENANT_CATALOGUE_MANAGE),
    AuthorizationDeniedError,
  );
  assert.equal(
    policy.requireTenantPermission(dual, tenantContext, PERMISSION.TENANT_CONFIGURE),
    true,
  );
  assert.equal(
    policy.requireTenantPermission(dual, tenantContext, PERMISSION.TENANT_CATALOGUE_MANAGE),
    true,
  );
});

test('Conference Manager may change Room business fields but not Site or provider assignment fields', async () => {
  const runtime = locationRuntime();
  const manager = principal([TENANT_ROLE.CONFERENCE_MANAGER]);
  const businessChange = configuration();
  businessChange.rooms[0] = { ...businessChange.rooms[0], name: 'Executive Room', capacity: 16 };
  await updateLocation(runtime.service, manager, businessChange);
  assert.equal(runtime.mutations.length, 1);

  const technicalRuntime = locationRuntime();
  const technicalChange = configuration();
  technicalChange.sites[0] = { ...technicalChange.sites[0], name: 'Berlin Campus' };
  await assert.rejects(
    updateLocation(technicalRuntime.service, manager, technicalChange),
    AuthorizationDeniedError,
  );
  assert.equal(technicalRuntime.mutations.length, 0);
});

test('Tenant Admin may change Site authority but not Room business fields', async () => {
  const runtime = locationRuntime();
  const admin = principal([TENANT_ROLE.TENANT_ADMIN]);
  const technicalChange = configuration();
  technicalChange.sites[0] = { ...technicalChange.sites[0], name: 'Berlin Campus' };
  await updateLocation(runtime.service, admin, technicalChange);
  assert.equal(runtime.mutations.length, 1);

  const businessRuntime = locationRuntime();
  const businessChange = configuration();
  businessChange.rooms[0] = { ...businessChange.rooms[0], name: 'Executive Room' };
  await assert.rejects(
    updateLocation(businessRuntime.service, admin, businessChange),
    AuthorizationDeniedError,
  );
  assert.equal(businessRuntime.mutations.length, 0);
});

test('dual role may apply one mutation spanning technical and Room business fields', async () => {
  const runtime = locationRuntime();
  const dual = principal([TENANT_ROLE.CONFERENCE_MANAGER, TENANT_ROLE.TENANT_ADMIN]);
  const proposed = configuration();
  proposed.sites[0] = { ...proposed.sites[0], name: 'Berlin Campus' };
  proposed.rooms[0] = { ...proposed.rooms[0], name: 'Executive Room' };
  await updateLocation(runtime.service, dual, proposed);
  assert.equal(runtime.mutations.length, 1);
});

test('Employee and cross-Tenant location access are denied before persistence', async () => {
  const employeeRuntime = locationRuntime();
  await assert.rejects(
    employeeRuntime.service.getCurrent({
      principal: principal(),
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );

  const crossTenantRuntime = locationRuntime();
  await assert.rejects(
    crossTenantRuntime.service.getCurrent({
      principal: principal([TENANT_ROLE.CONFERENCE_MANAGER], TENANT_B),
      tenantContext: { tenantId: TENANT_A, status: 'active' },
      correlationId: CORRELATION_ID,
    }),
    AuthorizationDeniedError,
  );
});
