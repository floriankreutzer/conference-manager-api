import { AuthorizationInputError } from './errors.js';
import { TENANT_ROLE, tenantAuthorizationSnapshot } from './policy.js';
import { normalizeInvitationRecipient } from '../domain/invitation-recipient.js';
import { isInternalUuid } from '../domain/identifiers.js';

export const CUSTOMER_INVITATION_BATCH_LIMIT = 20;

function invalid() { throw new AuthorizationInputError('CUSTOMER_INVITATION_INPUT_INVALID'); }
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !fields.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function list(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
  }
  return value;
}
export function normalizeCustomerInvitationIntent(value) {
  record(value, ['recipient', 'roles', 'locale']);
  if (!['de', 'en'].includes(value.locale)) invalid();
  const requested = list(value.roles, 2);
  let recipient, roles;
  try {
    recipient = normalizeInvitationRecipient(value.recipient);
    roles = tenantAuthorizationSnapshot([TENANT_ROLE.EMPLOYEE, ...requested]).roles
      .filter((role) => role !== TENANT_ROLE.EMPLOYEE);
  } catch { invalid(); }
  return Object.freeze({ recipient, roles: Object.freeze(roles), locale: value.locale });
}

// Validated intent only. This does not authorize an actor, grant a role, establish
// membership, link provider identities or admit a recipient to an existing user.
export function normalizeCustomerInvitationBatch(value) {
  record(value, ['commandId', 'invitations']);
  if (!isInternalUuid(value.commandId)) invalid();
  const source = list(value.invitations, CUSTOMER_INVITATION_BATCH_LIMIT);
  if (source.length < 1) invalid();
  const invitations = source.map(normalizeCustomerInvitationIntent);
  if (new Set(invitations.map((entry) => entry.recipient)).size !== invitations.length) invalid();
  return Object.freeze({ commandId: value.commandId.toLowerCase(), invitations: Object.freeze(invitations) });
}
