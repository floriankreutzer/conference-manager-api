import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../../domain/invitation-recipient.js';
import { normalizePrincipal } from '../../identity/principal.js';
import { AuthorizationDeniedError } from '../../authorization/errors.js';
import { createAuthorizationPolicy, PERMISSION } from '../../authorization/policy.js';

const authorizationPolicy = createAuthorizationPolicy();

export function customerInvitationUuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CUSTOMER_INVITATION_IDENTIFIER_INVALID');
  return value.toLowerCase();
}
export function customerInvitationActor(input, environment) {
  if (input?.environment !== environment) throw new TypeError('CUSTOMER_INVITATION_ENVIRONMENT_INVALID');
  const tenantId = customerInvitationUuid(input.tenantId), principal = normalizePrincipal(input.principal);
  authorizationPolicy.requireTenantPermission(principal, { tenantId }, PERMISSION.TENANT_USERS_MANAGE);
  return { tenantId, principal, correlationId: customerInvitationUuid(input.correlationId) };
}
export function customerInvitationDenied() {
  throw new AuthorizationDeniedError('RESOURCE_NOT_AVAILABLE', { conceal: true });
}
export async function lockCustomerInvitationActor(client, actor) {
  const tenant = await client.query({ name: 'customer-invitation-tenant-lock',
    text: "SELECT id,display_name FROM tenants WHERE id=$1 AND status IN ('pending','onboarding','ready','active') FOR UPDATE",
    values: [actor.tenantId] });
  if (tenant.rowCount !== 1) customerInvitationDenied();
  const user = await client.query({ name: 'customer-invitation-user-lock',
    text: 'SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND active=true AND security_version=$3 FOR SHARE',
    values: [actor.tenantId,actor.principal.userId,actor.principal.session.securityVersion] });
  if (user.rowCount !== 1) customerInvitationDenied();
  const session = await client.query({ name: 'customer-invitation-session-lock',
    text: `SELECT id FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND principal_version=$4
      AND revoked_at IS NULL AND expires_at>clock_timestamp() AND roles @> ARRAY['tenant_admin']::text[]
      AND permissions @> ARRAY['tenant:users:manage']::text[] FOR SHARE`,
    values: [actor.tenantId,actor.principal.userId,actor.principal.session.id,actor.principal.session.securityVersion] });
  if (session.rowCount !== 1) customerInvitationDenied();
  return tenant.rows[0].display_name;
}
export function openCustomerMailbox(cipher, environment, row) {
  const bytes = cipher.open(row.recipient_envelope, { environment, mailboxId: row.mailbox_id, recordId: row.mailbox_id,
    purpose: 'mailbox_recipient', tenantId: null });
  try {
    const recipient = normalizeInvitationRecipient(bytes.toString('utf8'));
    if (Buffer.from(recipient, 'utf8').compare(bytes) !== 0 || cipher.recipientLookup(recipient) !== row.lookup_hash) {
      throw new TypeError('CUSTOMER_INVITATION_CUSTODY_INVALID');
    }
    return recipient;
  } finally { bytes.fill(0); }
}
export function customerInvitationRecord(cipher, environment, row) {
  if (!row) customerInvitationDenied();
  return Object.freeze({ tenantId: row.tenant_id, environment, id: row.id, revision: Number(row.revision),
    recipient: openCustomerMailbox(cipher, environment, row), roles: Object.freeze([...row.elevated_roles]), locale: row.locale,
    state: row.invitation_state, expiresAt: row.expires_at.toISOString(), delivery: row.delivery_state });
}
export const CUSTOMER_INVITATION_COLUMNS = `invitation.id,invitation.tenant_id,invitation.revision,invitation.elevated_roles,
  invitation.locale,invitation.expires_at,mailbox.id AS mailbox_id,mailbox.lookup_hash,mailbox.recipient_envelope,
  CASE WHEN invitation.revoked_at IS NOT NULL THEN 'revoked' WHEN invitation.accepted_at IS NOT NULL THEN 'accepted'
    WHEN invitation.expires_at<=clock_timestamp() THEN 'expired' ELSE 'pending' END AS invitation_state,
  CASE delivery.status WHEN 'accepted' THEN 'accepted' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled'
    WHEN 'claimed' THEN 'processing' WHEN 'queued' THEN 'queued' ELSE 'failed' END AS delivery_state`;
export const CUSTOMER_INVITATION_JOINS = `JOIN customer_access_mailboxes mailbox
  ON mailbox.environment=invitation.environment AND mailbox.id=invitation.mailbox_id
  LEFT JOIN LATERAL (SELECT status FROM customer_access_deliveries
    WHERE environment=invitation.environment AND tenant_id=invitation.tenant_id AND invitation_id=invitation.id
      AND invitation_revision<=invitation.revision ORDER BY invitation_revision DESC,created_at DESC,id DESC LIMIT 1) delivery ON true`;
