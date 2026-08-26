import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExchangeApplicationRbacEvidenceError,
  validateExchangeApplicationRbacEvidence,
} from '../src/operator/exchange-application-rbac-evidence.js';

function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    verifiedAt: '2026-08-26T10:00:00.000Z',
    centralAppRegistration: { calendarsReadWriteRequested: false },
    customerServicePrincipal: { unscopedCalendarsReadWriteGranted: false },
    configuredRoomIds: ['room-a', 'room-b'],
    authorizationChecks: [
      { roomId: 'room-a', roleName: 'Application Calendars.ReadWrite', inScope: true },
      { roomId: 'room-b', roleName: 'Application Calendars.ReadWrite', inScope: true },
    ],
    negativeControl: { roleName: 'Application Calendars.ReadWrite', inScope: false },
    ...overrides,
  };
}

test('non-sensitive Exchange RBAC evidence verifies every configured room and a negative control', () => {
  const result = validateExchangeApplicationRbacEvidence(evidence());
  assert.deepEqual(result.summary, {
    status: 'verified',
    configuredRoomCount: 2,
    inScopeRoomCount: 2,
    negativeControlDenied: true,
    unscopedWriteAbsent: true,
  });
  assert.equal(Object.hasOwn(result, 'servicePrincipalObjectId'), false);
  assert.equal(JSON.stringify(result).includes('@'), false);
});

test('out-of-scope configured rooms and failed negative control fail closed', () => {
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      configuredRoomIds: ['room-a'],
      authorizationChecks: [
        { roomId: 'room-a', roleName: 'Application Calendars.ReadWrite', inScope: false },
      ],
    })),
    ExchangeApplicationRbacEvidenceError,
  );
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      negativeControl: { roleName: 'Application Calendars.ReadWrite', inScope: true },
    })),
    /EXCHANGE_APPLICATION_RBAC_NEGATIVE_CONTROL_FAILED/,
  );
});

test('unscoped Entra request/grant, incomplete checks and unexpected sensitive-shaped fields are rejected', () => {
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      centralAppRegistration: { calendarsReadWriteRequested: true },
    })),
    /EXCHANGE_APPLICATION_RBAC_UNSCOPED_APP_REQUEST_PRESENT/,
  );
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      customerServicePrincipal: { unscopedCalendarsReadWriteGranted: true },
    })),
    /EXCHANGE_APPLICATION_RBAC_UNSCOPED_TENANT_GRANT_PRESENT/,
  );
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      configuredRoomIds: ['room-a', 'room-a'],
    })),
    /EXCHANGE_APPLICATION_RBAC_ROOM_DUPLICATE/,
  );
  assert.throws(
    () => validateExchangeApplicationRbacEvidence(evidence({
      authorizationChecks: [
        { roomId: 'room-a', roleName: 'Application Calendars.ReadWrite', inScope: true },
        { roomId: 'room-c', roleName: 'Application Calendars.ReadWrite', inScope: true },
      ],
    })),
    /EXCHANGE_APPLICATION_RBAC_CHECK_SET_MISMATCH/,
  );
  assert.throws(
    () => validateExchangeApplicationRbacEvidence({
      ...evidence(),
      accessToken: 'must-not-be-accepted',
    }),
    /EXCHANGE_APPLICATION_RBAC_DOCUMENT_INVALID/,
  );
});
