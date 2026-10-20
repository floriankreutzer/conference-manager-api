import { normalizeCustomerInvitationIntent } from '../authorization/customer-invitation-policy.js';
import { isInternalUuid } from '../domain/identifiers.js';

const STATES = new Set(['pending', 'accepted', 'revoked', 'expired']);
const DELIVERY_STATES = new Set(['queued', 'processing', 'accepted', 'failed', 'cancelled']);
const ROW_FIELDS = ['tenantId', 'environment', 'id', 'revision', 'recipient', 'roles', 'locale', 'state', 'expiresAt', 'delivery'];


function invalidResult() { throw new TypeError('CUSTOMER_INVITATION_RESULT_INVALID'); }
export function projectCustomerInvitation(row, tenantId, environment) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(row))) invalidResult();
  const keys = Reflect.ownKeys(row);
  if (keys.length !== ROW_FIELDS.length || keys.some((key) => {
    const property = Object.getOwnPropertyDescriptor(row, key);
    return !ROW_FIELDS.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalidResult();
  if (row.tenantId !== tenantId || row.environment !== environment || !isInternalUuid(row.id)
    || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision >= Number.MAX_SAFE_INTEGER
    || !STATES.has(row.state) || !DELIVERY_STATES.has(row.delivery) || (row.state === 'revoked' && row.delivery === 'queued')
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
export function projectCustomerInvitations(value, maximum, tenantId, environment) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalidResult();
  const results = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalidResult();
    results.push(projectCustomerInvitation(property.value, tenantId, environment));
  }
  if (new Set(results.map((entry) => entry.id)).size !== results.length) invalidResult();
  return Object.freeze(results);
}

