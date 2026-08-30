import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PLATFORM_AUDIT_ACTION, PLATFORM_AUDIT_RETENTION } from '../audit/event.js';
import { PLATFORM_ENTRA_PROVIDER } from './entra-client.js';
import { PlatformAuthorizationError } from './errors.js';
import { PLATFORM_PERMISSION, permissionsForPlatformRoles } from './policy.js';
import { normalizePlatformPrincipal } from './principal.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APPROVAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const MAX_TARGET_SCOPE_SIZE = 500;

function requireCorrelationId(value) {
  if (!isInternalUuid(value)) throw new TypeError('PLATFORM_CORRELATION_ID_INVALID');
  return value;
}

function requireApproval(value) {
  if (!APPROVAL_REFERENCE_PATTERN.test(value || '')) {
    throw new TypeError('PLATFORM_OPERATOR_APPROVAL_INVALID');
  }
  return value;
}

function requireReasonCode(value) {
  if (!REASON_CODE_PATTERN.test(value || '')) {
    throw new TypeError('PLATFORM_OPERATOR_REASON_INVALID');
  }
  return value;
}

function canonicalRoles(values) {
  if (!Array.isArray(values)) throw new TypeError('PLATFORM_ROLES_INVALID');
  const roles = [...values].sort();
  permissionsForPlatformRoles(roles);
  return Object.freeze(roles);
}

function canonicalScope(scopeMode, tenantIdsValue) {
  if (!['all', 'allowlist'].includes(scopeMode) || !Array.isArray(tenantIdsValue)) {
    throw new TypeError('PLATFORM_OPERATOR_SCOPE_INVALID');
  }
  const tenantIds = [...tenantIdsValue].sort();
  if (
    tenantIds.length > MAX_TARGET_SCOPE_SIZE
    || tenantIds.some((tenantId) => !isInternalUuid(tenantId))
    || new Set(tenantIds).size !== tenantIds.length
    || (scopeMode === 'all' && tenantIds.length !== 0)
  ) throw new TypeError('PLATFORM_OPERATOR_SCOPE_INVALID');
  return Object.freeze({ scopeMode, tenantIds: Object.freeze(tenantIds) });
}

function identity(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'subjectReference,tenantReference'
    || !GUID_PATTERN.test(value.tenantReference || '')
    || !GUID_PATTERN.test(value.subjectReference || '')
  ) throw new TypeError('PLATFORM_OPERATOR_IDENTITY_INVALID');
  return Object.freeze({
    provider: PLATFORM_ENTRA_PROVIDER,
    tenantReference: value.tenantReference.toLowerCase(),
    subjectReference: value.subjectReference.toLowerCase(),
  });
}

function state(operator) {
  if (!operator) return null;
  return Object.freeze({
    roleCount: operator.roles.length,
    scopeCount: operator.tenantIds.length,
    scopeMode: operator.scopeMode,
    securityVersion: operator.securityVersion,
    status: operator.status,
  });
}

export function createPlatformOperatorLifecycleService({
  repository,
  authorizationPolicy,
  tenantTargetPolicy,
  auditService,
  idFactory = () => randomUUID(),
} = {}) {
  if (
    !repository
    || typeof repository.createApproved !== 'function'
    || typeof repository.changeAccessApproved !== 'function'
    || typeof repository.disableApproved !== 'function'
  ) throw new TypeError('PLATFORM_OPERATOR_REPOSITORY_REQUIRED');
  if (!authorizationPolicy || typeof authorizationPolicy.authorize !== 'function') {
    throw new TypeError('PLATFORM_AUTHORIZATION_POLICY_REQUIRED');
  }
  if (
    !tenantTargetPolicy
    || typeof tenantTargetPolicy.authorize !== 'function'
    || typeof tenantTargetPolicy.queryScope !== 'function'
  ) throw new TypeError('PLATFORM_TENANT_TARGET_POLICY_REQUIRED');
  if (!auditService || typeof auditService.createEvent !== 'function') {
    throw new TypeError('PLATFORM_AUDIT_SERVICE_REQUIRED');
  }
  if (typeof idFactory !== 'function') throw new TypeError('PLATFORM_OPERATOR_ID_FACTORY_REQUIRED');

  async function approvalPair(principalValue, approverValue) {
    const principal = normalizePlatformPrincipal(principalValue);
    const approver = normalizePlatformPrincipal(approverValue);
    if (principal.operatorId === approver.operatorId) {
      throw new PlatformAuthorizationError('PLATFORM_OPERATOR_INDEPENDENT_APPROVAL_REQUIRED');
    }
    for (const candidate of [principal, approver]) {
      if (await authorizationPolicy.authorize(candidate, PLATFORM_PERMISSION.OPERATOR_MANAGE) !== true) {
        throw new PlatformAuthorizationError();
      }
    }
    return Object.freeze({ principal, approver });
  }

  async function authorizeScope(principal, approver, scope) {
    if (scope.scopeMode === 'all') {
      for (const candidate of [principal, approver]) {
        const current = await tenantTargetPolicy.queryScope(candidate);
        if (!current || current.mode !== 'all') {
          throw new PlatformAuthorizationError('PLATFORM_OPERATOR_FLEET_SCOPE_APPROVAL_REQUIRED');
        }
      }
      return;
    }
    for (const tenantId of scope.tenantIds) {
      for (const candidate of [principal, approver]) {
        if (await tenantTargetPolicy.authorize(candidate, tenantId) !== true) {
          throw new PlatformAuthorizationError('PLATFORM_TENANT_TARGET_DENIED');
        }
      }
    }
  }

  function approvalRecord(pair, correlationId) {
    return Object.freeze({
      actorOperatorId: pair.principal.operatorId,
      actorSecurityVersion: pair.principal.securityVersion,
      approverOperatorId: pair.approver.operatorId,
      approverSecurityVersion: pair.approver.securityVersion,
      correlationId: requireCorrelationId(correlationId),
    });
  }

  function eventFactory(pair, { approvalReference, reasonCode, correlationId }) {
    return (result) => [
      [pair.principal, 'requester'],
      [pair.approver, 'approver'],
    ].map(([principal, approvalRole]) => auditService.createEvent({
      principal,
      action: PLATFORM_AUDIT_ACTION.OPERATOR_CHANGED,
      targetType: 'platform_operator',
      targetId: result.operator.id,
      previousState: state(result.previous),
      newState: state(result.operator),
      metadata: {
        approvalReference,
        approvalRole,
        changeType: result.action,
        grantsRevoked: result.grantsRevoked,
        reasonCode,
        sessionsRevoked: result.sessionsRevoked,
        transactionsRevoked: result.transactionsRevoked,
      },
      retentionClass: PLATFORM_AUDIT_RETENTION.SECURITY,
      correlationId,
    }));
  }

  function evidence(values) {
    return Object.freeze({
      approvalReference: requireApproval(values.approvalReference),
      reasonCode: requireReasonCode(values.reasonCode),
      correlationId: requireCorrelationId(values.correlationId),
    });
  }

  return Object.freeze({
    async create({
      principal: principalValue,
      approverPrincipal: approverValue,
      providerIdentity,
      roles: roleValues,
      scopeMode,
      tenantIds,
      approvalReference,
      reasonCode,
      correlationId,
    } = {}) {
      const pair = await approvalPair(principalValue, approverValue);
      const scope = canonicalScope(scopeMode, tenantIds);
      await authorizeScope(pair.principal, pair.approver, scope);
      const id = idFactory();
      if (!isInternalUuid(id)) throw new TypeError('PLATFORM_OPERATOR_ID_FACTORY_INVALID');
      const eventEvidence = evidence({ approvalReference, reasonCode, correlationId });
      const result = await repository.createApproved(Object.freeze({
        ...approvalRecord(pair, eventEvidence.correlationId),
        id,
        providerIdentity: identity(providerIdentity),
        roles: canonicalRoles(roleValues),
        ...scope,
      }), eventFactory(pair, eventEvidence));
      if (!result) throw new PlatformAuthorizationError('PLATFORM_OPERATOR_CREATE_REJECTED');
      return result;
    },

    async changeAccess({
      principal: principalValue,
      approverPrincipal: approverValue,
      operatorId,
      expectedSecurityVersion,
      roles: roleValues,
      scopeMode,
      tenantIds,
      approvalReference,
      reasonCode,
      correlationId,
    } = {}) {
      const pair = await approvalPair(principalValue, approverValue);
      if (!isInternalUuid(operatorId) || !Number.isSafeInteger(expectedSecurityVersion)
        || expectedSecurityVersion < 1) throw new TypeError('PLATFORM_OPERATOR_TARGET_INVALID');
      const scope = canonicalScope(scopeMode, tenantIds);
      await authorizeScope(pair.principal, pair.approver, scope);
      const eventEvidence = evidence({ approvalReference, reasonCode, correlationId });
      const result = await repository.changeAccessApproved(Object.freeze({
        ...approvalRecord(pair, eventEvidence.correlationId),
        operatorId,
        expectedSecurityVersion,
        roles: canonicalRoles(roleValues),
        ...scope,
      }), eventFactory(pair, eventEvidence));
      if (!result) throw new PlatformAuthorizationError('PLATFORM_OPERATOR_CHANGE_REJECTED');
      return result;
    },

    async disable({
      principal: principalValue,
      approverPrincipal: approverValue,
      operatorId,
      expectedSecurityVersion,
      approvalReference,
      reasonCode,
      correlationId,
    } = {}) {
      const pair = await approvalPair(principalValue, approverValue);
      if (!isInternalUuid(operatorId) || !Number.isSafeInteger(expectedSecurityVersion)
        || expectedSecurityVersion < 1) throw new TypeError('PLATFORM_OPERATOR_TARGET_INVALID');
      const eventEvidence = evidence({ approvalReference, reasonCode, correlationId });
      const result = await repository.disableApproved(Object.freeze({
        ...approvalRecord(pair, eventEvidence.correlationId),
        operatorId,
        expectedSecurityVersion,
      }), eventFactory(pair, eventEvidence));
      if (!result) throw new PlatformAuthorizationError('PLATFORM_OPERATOR_DISABLE_REJECTED');
      return result;
    },
  });
}
