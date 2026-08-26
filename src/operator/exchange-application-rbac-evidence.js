const ROLE_NAME = 'Application Calendars.ReadWrite';
const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ROOMS = 500;

export class ExchangeApplicationRbacEvidenceError extends Error {
  constructor(code = 'EXCHANGE_APPLICATION_RBAC_EVIDENCE_INVALID') {
    super(code);
    this.name = 'ExchangeApplicationRbacEvidenceError';
    this.code = code;
  }
}

function invalid(code) {
  throw new ExchangeApplicationRbacEvidenceError(code);
}

function exactObject(value, expectedKeys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(code);
  }
}

function verifiedAt(value) {
  if (
    typeof value !== 'string'
    || !value.endsWith('Z')
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid('EXCHANGE_APPLICATION_RBAC_VERIFIED_AT_INVALID');
  }
  return value;
}

function roomCheck(value) {
  exactObject(
    value,
    ['roomId', 'roleName', 'inScope'],
    'EXCHANGE_APPLICATION_RBAC_ROOM_CHECK_INVALID',
  );
  if (!ROOM_ID_PATTERN.test(value.roomId)) invalid('EXCHANGE_APPLICATION_RBAC_ROOM_ID_INVALID');
  if (value.roleName !== ROLE_NAME || value.inScope !== true) {
    invalid('EXCHANGE_APPLICATION_RBAC_ROOM_OUT_OF_SCOPE');
  }
  return Object.freeze({ roomId: value.roomId, roleName: ROLE_NAME, inScope: true });
}

function roomId(value) {
  if (typeof value !== 'string' || !ROOM_ID_PATTERN.test(value)) {
    invalid('EXCHANGE_APPLICATION_RBAC_ROOM_ID_INVALID');
  }
  return value;
}

export function validateExchangeApplicationRbacEvidence(value) {
  exactObject(
    value,
    [
      'schemaVersion',
      'verifiedAt',
      'centralAppRegistration',
      'customerServicePrincipal',
      'configuredRoomIds',
      'authorizationChecks',
      'negativeControl',
    ],
    'EXCHANGE_APPLICATION_RBAC_DOCUMENT_INVALID',
  );
  if (value.schemaVersion !== 1) invalid('EXCHANGE_APPLICATION_RBAC_SCHEMA_UNSUPPORTED');

  exactObject(
    value.centralAppRegistration,
    ['calendarsReadWriteRequested'],
    'EXCHANGE_APPLICATION_RBAC_APP_REGISTRATION_INVALID',
  );
  if (value.centralAppRegistration.calendarsReadWriteRequested !== false) {
    invalid('EXCHANGE_APPLICATION_RBAC_UNSCOPED_APP_REQUEST_PRESENT');
  }

  exactObject(
    value.customerServicePrincipal,
    ['unscopedCalendarsReadWriteGranted'],
    'EXCHANGE_APPLICATION_RBAC_SERVICE_PRINCIPAL_INVALID',
  );
  if (value.customerServicePrincipal.unscopedCalendarsReadWriteGranted !== false) {
    invalid('EXCHANGE_APPLICATION_RBAC_UNSCOPED_TENANT_GRANT_PRESENT');
  }

  if (!Array.isArray(value.configuredRoomIds)
    || value.configuredRoomIds.length < 1
    || value.configuredRoomIds.length > MAX_ROOMS) {
    invalid('EXCHANGE_APPLICATION_RBAC_ROOM_SET_INVALID');
  }
  const configuredRoomIds = value.configuredRoomIds.map(roomId);
  const configuredRoomIdSet = new Set(configuredRoomIds);
  if (configuredRoomIdSet.size !== configuredRoomIds.length) {
    invalid('EXCHANGE_APPLICATION_RBAC_ROOM_DUPLICATE');
  }

  if (!Array.isArray(value.authorizationChecks)
    || value.authorizationChecks.length !== configuredRoomIds.length) {
    invalid('EXCHANGE_APPLICATION_RBAC_CHECK_SET_MISMATCH');
  }
  const authorizationChecks = value.authorizationChecks.map(roomCheck);
  const checkedRoomIds = new Set(authorizationChecks.map((entry) => entry.roomId));
  if (checkedRoomIds.size !== authorizationChecks.length) {
    invalid('EXCHANGE_APPLICATION_RBAC_ROOM_DUPLICATE');
  }
  if (configuredRoomIds.some((configuredRoomId) => !checkedRoomIds.has(configuredRoomId))) {
    invalid('EXCHANGE_APPLICATION_RBAC_CHECK_SET_MISMATCH');
  }

  exactObject(
    value.negativeControl,
    ['roleName', 'inScope'],
    'EXCHANGE_APPLICATION_RBAC_NEGATIVE_CONTROL_INVALID',
  );
  if (value.negativeControl.roleName !== ROLE_NAME || value.negativeControl.inScope !== false) {
    invalid('EXCHANGE_APPLICATION_RBAC_NEGATIVE_CONTROL_FAILED');
  }

  return Object.freeze({
    schemaVersion: 1,
    verifiedAt: verifiedAt(value.verifiedAt),
    configuredRoomIds: Object.freeze(configuredRoomIds),
    authorizationChecks: Object.freeze(authorizationChecks),
    negativeControl: Object.freeze({ roleName: ROLE_NAME, inScope: false }),
    summary: Object.freeze({
      status: 'verified',
      configuredRoomCount: configuredRoomIds.length,
      inScopeRoomCount: authorizationChecks.length,
      negativeControlDenied: true,
      unscopedWriteAbsent: true,
    }),
  });
}
