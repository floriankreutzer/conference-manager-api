import { normalizeCustomerInvitationBatch, normalizeCustomerInvitationIntent } from '../authorization/customer-invitation-policy.js';
import { AuthorizationDeniedError, AuthorizationInputError } from '../authorization/errors.js';
import { PERMISSION } from '../authorization/policy.js';
import { AUDIT_ACTION, AUDIT_OUTCOME, AUDIT_RETENTION_CLASS } from '../audit/event.js';
import { isInternalUuid } from '../domain/identifiers.js';

const STATES = new Set(['pending', 'accepted', 'revoked', 'expired']);
const DELIVERY_STATES = new Set(['queued', 'accepted', 'failed']);
const ROW_FIELDS = ['tenantId', 'environment', 'id', 'revision', 'recipient', 'roles', 'locale', 'state', 'expiresAt', 'delivery'];

function invalid() { throw new AuthorizationInputError('CUSTOMER_INVITATION_INPUT_INVALID'); }
function invalidResult() { throw new TypeError('CUSTOMER_INVITATION_RESULT_INVALID'); }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function revision(value) { if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid(); return value; }
function publicInvitation(row, tenantId, environment) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) invalidResult();
  const keys = Reflect.ownKeys(row);
  if (keys.length !== ROW_FIELDS.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(row, key);
    return !ROW_FIELDS.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalidResult();
  if (row.tenantId !== tenantId || row.environment !== environment || !isInternalUuid(row.id)
    || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER
    || !STATES.has(row.state) || !DELIVERY_STATES.has(row.delivery)
    || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))
    || new Date(row.expiresAt).toISOString() !== row.expiresAt) invalidResult();
  let intent;
  try { intent = normalizeCustomerInvitationIntent({ recipient: row.recipient, roles: row.roles, locale: row.locale }); }
  catch { invalidResult(); }
  const entry = intent;
  if (entry.recipient !== row.recipient || JSON.stringify(entry.roles) !== JSON.stringify(row.roles)) invalidResult();
  return Object.freeze({ id: row.id.toLowerCase(), revision: row.revision, ...entry,
    state: row.state, expiresAt: row.expiresAt, delivery: row.delivery });
}
function rows(value, maximum, tenantId, environment) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalidResult();
  const results = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalidResult();
    results.push(publicInvitation(property.value, tenantId, environment));
  }
  if (new Set(results.map((entry) => entry.id)).size !== results.length) invalidResult();
  return Object.freeze(results);
}

// Tenant Admin use cases only. Platform onboarding uses its own authenticated
// control-plane boundary; a Customer principal never carries Platform authority.
export function createCustomerInvitationService({ repository, authorizationPolicy, auditService, environment } = {}) {
  if (!repository || ['list', 'issueBatch', 'reissue', 'revoke'].some((method) => typeof repository[method] !== 'function')
    || !authorizationPolicy || typeof authorizationPolicy.requireTenantPermission !== 'function'
    || !auditService || ['createEvent', 'recordAuthorizationDenied'].some((method) => typeof auditService[method] !== 'function')
    || !['dev', 'int', 'prod'].includes(environment)) throw new TypeError('CUSTOMER_INVITATION_CONFIGURATION_INVALID');

  async function authorize(context, operation) {
    const { principal, tenantContext, correlationId } = context;
    uuid(correlationId);
    try {
      authorizationPolicy.requireTenantPermission(principal, tenantContext, PERMISSION.TENANT_USERS_MANAGE);
      uuid(tenantContext.tenantId); uuid(principal.userId);
      if (!['pending', 'onboarding', 'ready', 'active'].includes(tenantContext.status)) {
        throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
      }
    } catch (error) {
      // A mismatched context is not verified audit ownership. Preserve the concealed
      // denial without appending an event to either unverified Tenant context.
      if (error instanceof AuthorizationDeniedError && principal?.tenantId === tenantContext?.tenantId
        && isInternalUuid(principal?.tenantId) && isInternalUuid(principal?.userId)) await auditService.recordAuthorizationDenied({
        principal, tenantContext, correlationId, targetType: 'endpoint', targetId: 'customer_invitations', metadata: { operation },
      });
      throw error;
    }
    return { tenantId: tenantContext.tenantId, environment, principal, correlationId };
  }
  function auditEventFor({ principal, tenantContext, correlationId }, operation) {
    return ({ invitationId, nextRevision, occurredAt }) => {
      uuid(invitationId); revision(nextRevision);
      if (operation !== 'issue' && nextRevision < 2) invalidResult();
      if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))
        || new Date(occurredAt).toISOString() !== occurredAt) invalidResult();
      return auditService.createEvent({ principal, tenantContext, correlationId, action: AUDIT_ACTION.TENANT_ONBOARDING_INVITED,
        targetType: 'customer_invitation', targetId: invitationId, occurredAt,
        outcome: AUDIT_OUTCOME.SUCCESS, retentionClass: AUDIT_RETENTION_CLASS.ADMINISTRATIVE,
        // The locked repository supplies the verified next revision; mutations
        // therefore retain its authoritative predecessor without inventing expiry state.
        previousState: operation === 'issue' ? null : { revision: nextRevision - 1 }, newState: { revision: nextRevision,
          status: { issue: 'issued', reissue: 'reissued', revoke: 'revoked' }[operation] }, metadata: { operation },
      });
    };
  }
  async function mutate(context, operation, invitationId, expectedRevision) {
    const scope = await authorize(context, operation);
    const id = uuid(invitationId), expected = revision(expectedRevision);
    const result = await repository[operation]({ ...scope, invitationId: id, expectedRevision: expected,
      auditEventFor: auditEventFor(context, operation) });
    const value = publicInvitation(result, scope.tenantId, environment);
    if (value.id !== id || value.revision !== expected + 1
      || value.state !== (operation === 'revoke' ? 'revoked' : 'pending')
      || (operation === 'reissue' && value.delivery !== 'queued')) invalidResult();
    return value;
  }
  return Object.freeze({
    async list(context, { limit = 50, afterInvitationId = null } = {}) {
      const scope = await authorize(context, 'list');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
      const after = afterInvitationId === null ? null : uuid(afterInvitationId);
      const result = rows(await repository.list({ ...scope, limit, afterInvitationId: after }), limit, scope.tenantId, environment);
      for (let index = 0; index < result.length; index++) {
        if ((after !== null && result[index].id <= after) || (index > 0 && result[index].id <= result[index - 1].id)) invalidResult();
      }
      return result;
    },
    async issueBatch(context, command) {
      const scope = await authorize(context, 'issue');
      const normalized = normalizeCustomerInvitationBatch(command);
      const result = rows(await repository.issueBatch({ ...scope, commandId: normalized.commandId, invitations: normalized.invitations,
        auditEventFor: auditEventFor(context, 'issue') }), normalized.invitations.length, scope.tenantId, environment);
      if (result.length !== normalized.invitations.length) invalidResult();
      for (let index = 0; index < result.length; index++) {
        const actual = result[index], expected = normalized.invitations[index];
        if (actual.state !== 'pending' || actual.revision !== 1 || actual.delivery !== 'queued'
          || actual.recipient !== expected.recipient || actual.locale !== expected.locale
          || JSON.stringify(actual.roles) !== JSON.stringify(expected.roles)) invalidResult();
      }
      return result;
    },
    reissue(context, { invitationId, expectedRevision } = {}) { return mutate(context, 'reissue', invitationId, expectedRevision); },
    revoke(context, { invitationId, expectedRevision } = {}) { return mutate(context, 'revoke', invitationId, expectedRevision); },
  });
}
