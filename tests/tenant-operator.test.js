import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeTenantOperatorCommand,
  normalizeInvitationResult,
  parseTenantOperatorCommand,
  publicTenantOperatorResult,
} from '../src/operator/tenant-operator.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = '22222222-2222-4222-8222-222222222222';
const INVITATION_TOKEN = 'A'.repeat(43);

function inviteArguments(overrides = []) {
  return [
    'invite',
    '--environment', 'pilot',
    '--correlation-id', CORRELATION_ID,
    '--display-name', 'Example Organization',
    '--output', '/tmp/conference-manager-invitation.json',
    '--confirm', 'invite',
    '--apply',
    ...overrides,
  ];
}

function entitlementArguments(overrides = []) {
  return [
    'entitlement',
    '--environment', 'pilot',
    '--correlation-id', CORRELATION_ID,
    '--tenant-id', TENANT_ID,
    '--capability', 'microsoft.calendar',
    '--enabled', 'true',
    '--confirm', `entitlement:${TENANT_ID}:microsoft.calendar:true`,
    '--apply',
    ...overrides,
  ];
}

test('operator command parser accepts bounded invitation and readiness contracts', () => {
  assert.deepEqual(parseTenantOperatorCommand(inviteArguments()), {
    kind: 'invite',
    environment: 'pilot',
    correlationId: CORRELATION_ID,
    displayName: 'Example Organization',
    outputPath: '/tmp/conference-manager-invitation.json',
  });

  assert.deepEqual(parseTenantOperatorCommand([
    'readiness',
    '--environment', 'production',
    '--correlation-id', CORRELATION_ID,
    '--tenant-id', TENANT_ID,
  ]), {
    kind: 'readiness',
    environment: 'production',
    correlationId: CORRELATION_ID,
    tenantId: TENANT_ID,
  });
});

test('mutating commands require apply and an exact target-bound confirmation', () => {
  assert.throws(
    () => parseTenantOperatorCommand(inviteArguments().filter((value) => value !== '--apply')),
    (error) => error?.code === 'TENANT_OPERATOR_APPLY_REQUIRED',
  );

  const confirmationIndex = entitlementArguments().indexOf('--confirm') + 1;
  const mismatched = entitlementArguments();
  mismatched[confirmationIndex] = `entitlement:${TENANT_ID}:microsoft.calendar:false`;
  assert.throws(
    () => parseTenantOperatorCommand(mismatched),
    (error) => error?.code === 'TENANT_OPERATOR_CONFIRMATION_INVALID',
  );
});

test('operator input rejects browser authority, duplicate flags and unsafe values', () => {
  assert.throws(
    () => parseTenantOperatorCommand([
      ...inviteArguments(),
      '--provider-tenant-id', TENANT_ID,
    ]),
    (error) => error?.code === 'TENANT_OPERATOR_ARGUMENT_UNSUPPORTED',
  );
  assert.throws(
    () => parseTenantOperatorCommand([...inviteArguments(), '--apply']),
    (error) => error?.code === 'TENANT_OPERATOR_ARGUMENT_DUPLICATE',
  );
  assert.throws(
    () => parseTenantOperatorCommand(entitlementArguments([
      '--capability', 'microsoft.unknown',
    ])),
    (error) => error?.code === 'TENANT_OPERATOR_ARGUMENT_DUPLICATE',
  );
  assert.throws(
    () => parseTenantOperatorCommand([
      'lifecycle',
      '--environment', 'pilot',
      '--correlation-id', CORRELATION_ID,
      '--tenant-id', TENANT_ID,
      '--target', 'archived',
      '--confirm', `lifecycle:${TENANT_ID}:archived`,
      '--apply',
    ]),
    (error) => error?.code === 'TENANT_OPERATOR_LIFECYCLE_INVALID',
  );
  assert.throws(
    () => parseTenantOperatorCommand([
      'invite',
      '--environment', 'pilot',
      '--correlation-id', CORRELATION_ID,
      '--display-name', 'Example Organization',
      '--output', 'relative/invitation.json',
      '--confirm', 'invite',
      '--apply',
    ]),
    (error) => error?.code === 'TENANT_OPERATOR_OUTPUT_ABSOLUTE_REQUIRED',
  );
});

test('operator execution forwards only validated server-side service inputs', async () => {
  const command = parseTenantOperatorCommand(inviteArguments());
  const operatorContext = Object.freeze({ source: 'test_operator' });
  let observed;
  const result = await executeTenantOperatorCommand({
    command,
    operatorContext,
    services: {
      onboarding: {
        async createTenantInvitation(values) {
          observed = values;
          return {
            tenantId: TENANT_ID,
            invitationToken: INVITATION_TOKEN,
            expiresAt: '2026-08-27T08:00:00.000Z',
          };
        },
      },
    },
  });

  assert.equal(observed.operatorContext, operatorContext);
  assert.deepEqual(Object.keys(observed).sort(), [
    'operatorContext',
    'displayName',
    'correlationId',
  ].sort());
  assert.equal(normalizeInvitationResult(result).invitationToken, INVITATION_TOKEN);

  const publicResult = publicTenantOperatorResult(command, result);
  const serialized = JSON.stringify(publicResult);
  assert.equal(serialized.includes(INVITATION_TOKEN), false);
  assert.equal(serialized.includes(TENANT_ID), false);
  assert.deepEqual(publicResult, {
    status: 'completed',
    command: 'invite',
    correlationId: CORRELATION_ID,
  });
});

test('readiness output is positively shaped and contains no Tenant selector', async () => {
  const command = parseTenantOperatorCommand([
    'readiness',
    '--environment', 'pilot',
    '--correlation-id', CORRELATION_ID,
    '--tenant-id', TENANT_ID,
  ]);
  const value = {
    tenantStatus: 'onboarding',
    ready: true,
    checks: {
      tenantIdentityClaimed: true,
      microsoft365Connected: true,
      placesPermissionGranted: true,
      calendarPermissionGranted: true,
      roomImported: true,
      freeBusyVerified: true,
      directoryEntitled: true,
      calendarEntitled: true,
    },
    entitlements: {
      microsoftDirectory: true,
      microsoftCalendar: true,
      microsoftCalendarWrite: false,
    },
  };
  const publicResult = publicTenantOperatorResult(command, value);
  assert.equal(publicResult.readiness.ready, true);
  assert.equal(JSON.stringify(publicResult).includes(TENANT_ID), false);

  assert.throws(
    () => publicTenantOperatorResult(command, {
      ...value,
      checks: { ...value.checks, browserControlled: true },
    }),
    /TENANT_OPERATOR_READINESS_RESULT_INVALID/,
  );
});
