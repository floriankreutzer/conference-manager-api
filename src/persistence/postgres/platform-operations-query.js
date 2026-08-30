import { createHmac, timingSafeEqual } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';

const CURSOR_KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const CURSOR_SIGNATURE = /^[0-9a-f]{64}$/;
const MAX_CURSOR_BYTES = 4_096;

function invalid(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function exactScope(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'mode,operatorId,securityVersion'
    || !['all', 'allowlist'].includes(value.mode)
    || !isInternalUuid(value.operatorId)
    || !Number.isSafeInteger(value.securityVersion)
    || value.securityVersion < 1
  ) invalid('PLATFORM_OPERATION_SCOPE_INVALID');
  return Object.freeze({
    mode: value.mode,
    operatorId: value.operatorId.toLowerCase(),
    securityVersion: value.securityVersion,
  });
}

export function requirePlatformFleetScope(authorization) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    invalid('PLATFORM_OPERATION_AUTHORIZATION_INVALID');
  }
  return exactScope(authorization.targetAuthorization);
}

export function requirePlatformOperatorId(authorization) {
  const operatorId = authorization?.principal?.operatorId;
  if (!isInternalUuid(operatorId)) invalid('PLATFORM_OPERATION_AUTHORIZATION_INVALID');
  return operatorId.toLowerCase();
}

export function platformScopeSql(alias, firstParameter = 1) {
  if (typeof alias !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(alias)) {
    throw new TypeError('PLATFORM_OPERATION_SQL_ALIAS_INVALID');
  }
  const operator = `$${firstParameter}`;
  const securityVersion = `$${firstParameter + 1}`;
  const mode = `$${firstParameter + 2}`;
  return `
    EXISTS (
      SELECT 1
      FROM platform_operators platform_scope_operator
      WHERE platform_scope_operator.id = ${operator}
        AND platform_scope_operator.status = 'active'
        AND platform_scope_operator.security_version = ${securityVersion}
        AND platform_scope_operator.scope_mode = ${mode}
        AND (
          platform_scope_operator.scope_mode = 'all'
          OR EXISTS (
            SELECT 1
            FROM platform_operator_tenant_scopes platform_scope_target
            WHERE platform_scope_target.operator_id = platform_scope_operator.id
              AND platform_scope_target.tenant_id = ${alias}.id
          )
        )
    )
  `;
}

export function createPlatformOperationCursorCodec({ secret: secretValue } = {}) {
  if (typeof secretValue !== 'string') throw new TypeError('PLATFORM_CURSOR_HMAC_SECRET_REQUIRED');
  const secret = Buffer.from(secretValue, 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) {
    throw new TypeError('PLATFORM_CURSOR_HMAC_SECRET_INVALID');
  }

  function sign(payload) {
    return createHmac('sha256', secret)
      .update('conference-manager:platform-operation-cursor:v1\0', 'utf8')
      .update(payload, 'utf8')
      .digest('hex');
  }

  function encode({ kind, scope: scopeValue, snapshotAt, filters, position }) {
    const scope = exactScope(scopeValue);
    const snapshotMs = Date.parse(snapshotAt);
    if (!CURSOR_KIND.test(kind || '')) invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    if (
      typeof snapshotAt !== 'string'
      || !Number.isFinite(snapshotMs)
      || new Date(snapshotMs).toISOString() !== snapshotAt
      || !filters
      || typeof filters !== 'object'
      || Array.isArray(filters)
      || !position
      || typeof position !== 'object'
      || Array.isArray(position)
    ) invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      kind,
      scope,
      snapshotAt,
      filters,
      position,
    }), 'utf8').toString('base64url');
    const cursor = `${payload}.${sign(payload)}`;
    if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    return cursor;
  }

  function decode(cursor, { kind, scope: scopeValue, filters }) {
    const scope = exactScope(scopeValue);
    if (typeof cursor !== 'string' || Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
      invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    }
    const parts = cursor.split('.');
    if (parts.length !== 2 || !CURSOR_SIGNATURE.test(parts[1])) invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    const expected = Buffer.from(sign(parts[0]), 'ascii');
    const actual = Buffer.from(parts[1], 'ascii');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    }
    let value;
    try {
      value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    }
    const snapshotMs = Date.parse(value?.snapshotAt);
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'filters,kind,position,scope,snapshotAt,version'
      || value.version !== 1
      || value.kind !== kind
      || JSON.stringify(value.scope) !== JSON.stringify(scope)
      || JSON.stringify(value.filters) !== JSON.stringify(filters)
      || typeof value.snapshotAt !== 'string'
      || !Number.isFinite(snapshotMs)
      || new Date(snapshotMs).toISOString() !== value.snapshotAt
      || !value.position
      || typeof value.position !== 'object'
      || Array.isArray(value.position)
    ) invalid('PLATFORM_OPERATION_CURSOR_INVALID');
    return Object.freeze({
      snapshotAt: value.snapshotAt,
      position: Object.freeze({ ...value.position }),
    });
  }

  return Object.freeze({ encode, decode });
}
