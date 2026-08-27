import assert from 'node:assert/strict';
import test from 'node:test';
import { asApiError } from '../src/api-error.js';
import {
  TenantSettingsConflictError,
  TenantSettingsInputError,
} from '../src/application/tenant-settings-errors.js';
import {
  TenantBookingPolicyInputError,
  TenantBookingPolicyViolationError,
} from '../src/domain/tenant-booking-policies.js';
import { TenantCostAllocationInputError } from '../src/domain/tenant-cost-allocation.js';

test('Tenant settings input failures use the bounded validation response', () => {
  const error = asApiError(new TenantSettingsInputError('TENANT_SETTINGS_REVISION_INVALID'));
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'VALIDATION_FAILED');
  assert.equal(error.context, null);
});

test('Tenant settings conflicts expose only the safe current revision context', () => {
  const error = asApiError(new TenantSettingsConflictError(9));
  assert.equal(error.statusCode, 409);
  assert.equal(error.code, 'TENANT_SETTINGS_REVISION_CONFLICT');
  assert.deepEqual(error.context, { currentRevision: 9 });
});

test('Tenant settings conflict context rejects unbounded revision values before serialization', () => {
  for (const value of [0, -1, 1.5, '9', null, undefined, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => new TenantSettingsConflictError(value),
      /TENANT_SETTINGS_CURRENT_REVISION_INVALID/,
    );
  }
});

test('Request-boundary policy and allocation input failures use bounded validation errors', () => {
  for (const domainError of [
    new TenantBookingPolicyInputError('TENANT_BOOKING_POLICY_START_INVALID'),
    new TenantCostAllocationInputError('TENANT_COST_ALLOCATION_TOTAL_INVALID'),
  ]) {
    const error = asApiError(domainError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.equal(error.context, null);
  }
});

test('booking-policy violations expose only allowlisted bounded numeric presentation context', () => {
  const bounded = asApiError(new TenantBookingPolicyViolationError(
    'BOOKING_POLICY_LEAD_TIME_VIOLATION',
    {
      requiredMinutes: 60,
      tenantId: '11111111-1111-4111-8111-111111111111',
      arbitrary: 42,
    },
  ));
  assert.equal(bounded.statusCode, 409);
  assert.equal(bounded.code, 'BOOKING_POLICY_LEAD_TIME_VIOLATION');
  assert.deepEqual(bounded.context, { requiredMinutes: 60 });

  const unrecognized = asApiError(new TenantBookingPolicyViolationError(
    'ATTACKER_CONTROLLED_CODE',
    { requiredMinutes: Number.MAX_SAFE_INTEGER },
  ));
  assert.equal(unrecognized.code, 'BOOKING_POLICY_VIOLATION');
  assert.equal(unrecognized.context, null);
});
