import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBookingPolicyConfiguration } from '../src/domain/tenant-configuration/booking-policies.js';
import { normalizeCatalogConfiguration } from '../src/domain/tenant-configuration/catalog.js';
import { normalizeCostAllocationConfiguration } from '../src/domain/tenant-configuration/cost-allocation.js';
import { normalizeLocationsConfiguration } from '../src/domain/tenant-configuration/locations.js';
import { normalizeOrganizationConfiguration } from '../src/domain/tenant-configuration/organization.js';
import {
  requireConfigurationSnapshot,
  TenantConfigurationInputError,
} from '../src/domain/tenant-configuration/protocol.js';
import { createOrganizationAdministrationService } from '../src/application/tenant-configuration/organization-service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';
const principal = Object.freeze({ userId: USER_ID });
const tenantContext = Object.freeze({ tenantId: TENANT_ID });

function organization(displayName = 'Example Tenant') {
  return {
    organization: {
      displayName,
      defaultLocale: 'de',
      currency: 'EUR',
      theme: { accent: 'bordeaux', logoAssetId: null },
    },
  };
}

function locations() {
  return {
    sites: [{
      id: 'berlin',
      name: 'Berlin',
      active: true,
      timeZone: 'Europe/Berlin',
      address: null,
      rooms: [{
        id: 'room-a',
        name: 'Room A',
        capacity: 10,
        active: true,
        floor: '1',
        equipment: ['display'],
        accessibility: ['step_free'],
      }],
    }],
  };
}

function catalog() {
  const base = {
    description: null,
    active: true,
    priceMinor: 500,
    currency: 'EUR',
    billingUnit: 'per_unit',
    dietaryTags: [],
    allergens: [],
  };
  return {
    services: [{ ...base, id: 'service-1', name: 'Service', billingUnit: 'per_booking' }],
    cateringItems: [{ ...base, id: 'item-1', name: 'Water' }],
    cateringPackages: [{
      ...base,
      id: 'package-1',
      name: 'Standard',
      billingUnit: 'per_person',
      itemIds: ['item-1'],
    }],
  };
}

test('configuration snapshots reject dangerous object graphs and oversized content', () => {
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(() => requireConfigurationSnapshot(dangerous), TenantConfigurationInputError);
  assert.throws(
    () => requireConfigurationSnapshot({ content: 'x'.repeat(262_145) }),
    /TENANT_CONFIGURATION_SNAPSHOT_TOO_LARGE/,
  );
});

test('organization configuration accepts only approved values and internal assets', () => {
  assert.equal(normalizeOrganizationConfiguration(organization()).organization.defaultLocale, 'de');
  const remote = organization();
  remote.organization.theme.logoAssetId = 'https://example.invalid/logo.png';
  assert.throws(() => normalizeOrganizationConfiguration(remote), /TENANT_BRAND_ASSET_ID_INVALID/);
});

test('location configuration preserves identifiers and rejects provider-owned fields', () => {
  const current = normalizeLocationsConfiguration(locations());
  assert.throws(
    () => normalizeLocationsConfiguration({ sites: [] }, current),
    /TENANT_SITE_ARCHIVE_REQUIRED/,
  );
  const providerField = locations();
  providerField.sites[0].rooms[0].providerReference = 'provider-room';
  assert.throws(() => normalizeLocationsConfiguration(providerField), /TENANT_CONFIGURATION_INVALID/);
});

test('catalog configuration validates exact money and package references', () => {
  const normalized = normalizeCatalogConfiguration(catalog());
  assert.equal(normalized.cateringPackages[0].priceMinor, 500);
  const unknownItem = catalog();
  unknownItem.cateringPackages[0].itemIds = ['missing'];
  assert.throws(() => normalizeCatalogConfiguration(unknownItem), /TENANT_CATALOG_PACKAGE_ITEM_NOT_FOUND/);
  const floatingPrice = catalog();
  floatingPrice.services[0].priceMinor = 1.5;
  assert.throws(() => normalizeCatalogConfiguration(floatingPrice), /TENANT_CATALOG_PRICE_INVALID/);
});

test('booking and cost policy bounds remain server-side invariants', () => {
  assert.throws(() => normalizeBookingPolicyConfiguration({
    policy: {
      minimumLeadMinutes: 0,
      maximumAdvanceDays: 365,
      maximumDurationMinutes: 1440,
      maximumParticipants: 10,
      approvalRequiredAboveParticipants: 11,
      cancellationDeadlineMinutes: 0,
    },
  }), /TENANT_BOOKING_APPROVAL_THRESHOLD_INVALID/);
  assert.throws(() => normalizeCostAllocationConfiguration({
    policy: { required: true, maximumAllocations: 2, defaultCostCenterId: null },
    costCenters: [],
  }), /TENANT_ACTIVE_COST_CENTER_REQUIRED/);
});

test('versioned service authorizes and emits revision-only audit evidence', async () => {
  const calls = [];
  const repository = {
    current: async () => ({ revision: 3, configuration: organization('Before') }),
    update: async (input) => { calls.push(input); return { revision: 4, configuration: input.configuration }; },
    listHistory: async () => [],
    revision: async () => null,
    rollback: async (input) => ({ revision: 4, sourceRevision: input.sourceRevision }),
  };
  const authorizationPolicy = {
    requireTenantPermission(receivedPrincipal, receivedTenant, permission) {
      assert.equal(receivedPrincipal, principal);
      assert.equal(receivedTenant, tenantContext);
      assert.equal(permission, 'tenant:configure');
    },
  };
  const auditService = {
    createEvent(event) {
      assert.deepEqual(event.previousState, { revision: 3 });
      assert.deepEqual(event.newState, { revision: 4 });
      assert.equal(Object.hasOwn(event.metadata, 'configuration'), false);
      return Object.freeze(event);
    },
  };
  const service = createOrganizationAdministrationService({
    repository,
    authorizationPolicy,
    auditService,
    clock: () => Date.parse('2026-08-26T20:00:00.000Z'),
  });
  const result = await service.update({
    principal,
    tenantContext,
    correlationId: CORRELATION_ID,
    expectedRevision: 3,
    configuration: organization('After'),
  });
  assert.equal(result.revision, 4);
  assert.equal(calls[0].tenantId, TENANT_ID);
  assert.equal(calls[0].configuration.organization.displayName, 'After');
  assert.equal(calls[0].auditEvent.targetId, 'organization');
});
