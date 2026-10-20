import { randomUUID } from 'node:crypto';
import { normalizeCustomerInvitationIntent } from '../../authorization/customer-invitation-policy.js';
import { CustomerInvitationConflictError } from '../../domain/customer-invitation-errors.js';
import { isPostgresTransactionActive } from './transaction.js';
import { customerInvitationUuid as uuid,customerInvitationRecord,openCustomerMailbox,
  CUSTOMER_INVITATION_COLUMNS,CUSTOMER_INVITATION_JOINS } from './customer-invitation-records.js';

// Private custody only. Caller repositories must establish current Customer or
// Platform authority and lock the Tenant before joining this same transaction.
export function createCustomerInvitationCustody(pool,{ environment,cipher,content,identifierFactory=randomUUID } = {}) {
  if (!pool || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment)
    || !cipher || ['seal','open','recipientLookup'].some(key => typeof cipher[key]!=='function')
    || typeof content?.invitation!=='function' || typeof identifierFactory!=='function') {
    throw new TypeError('CUSTOMER_INVITATION_CUSTODY_CONFIGURATION_INVALID');
  }
  const nextId=() => uuid(identifierFactory());
  function transaction(client) {
    if (!isPostgresTransactionActive(pool,client)) throw new TypeError('CUSTOMER_INVITATION_TRANSACTION_REQUIRED');
  }
  async function load(client, tenantId, invitationId) {
    transaction(client);
    const result = await client.query({ name: 'customer-invitation-read-one',
      text: `SELECT ${CUSTOMER_INVITATION_COLUMNS} FROM customer_member_invitations invitation ${CUSTOMER_INVITATION_JOINS}
        WHERE invitation.environment=$1 AND invitation.tenant_id=$2 AND invitation.id=$3`,
      values: [environment,tenantId,invitationId] });
    return customerInvitationRecord(cipher, environment, result.rows[0]);
  }
  async function mailbox(client, recipient) {
    const hash = cipher.recipientLookup(recipient);
    const proposedId = nextId(), plaintext = Buffer.from(recipient, 'utf8');
    let envelope;
    try { envelope = cipher.seal(plaintext, { environment, mailboxId: proposedId, recordId: proposedId,
      purpose: 'mailbox_recipient', tenantId: null }); } finally { plaintext.fill(0); }
    await client.query({ name: 'customer-invitation-mailbox-insert',
      text: `INSERT INTO customer_access_mailboxes(environment,id,lookup_hash,recipient_envelope)
        VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(environment,lookup_hash) DO NOTHING`,
      values: [environment,proposedId,hash,JSON.stringify(envelope)] });
    const result = await client.query({ name: 'customer-invitation-mailbox-lock',
      text: `SELECT id AS mailbox_id,lookup_hash,recipient_envelope FROM customer_access_mailboxes
        WHERE environment=$1 AND lookup_hash=$2 FOR UPDATE`, values: [environment,hash] });
    if (result.rowCount !== 1 || openCustomerMailbox(cipher, environment, result.rows[0]) !== recipient) {
      throw new Error('CUSTOMER_INVITATION_CUSTODY_INVALID');
    }
    return result.rows[0].mailbox_id;
  }
  async function delivery(client, { tenantId, invitationId, invitationRevision, mailboxId, recipient, tenantDisplayName, locale, now }) {
    transaction(client);
    const deliveryId = nextId(), message = content.invitation({ recipient, tenantDisplayName, locale, deliveryId });
    const plaintext = Buffer.from(JSON.stringify(message), 'utf8');
    let envelope;
    try { envelope = cipher.seal(plaintext, { environment, mailboxId, recordId: deliveryId, purpose: 'membership_invitation', tenantId }); }
    finally { plaintext.fill(0); }
    await client.query({ name: 'customer-invitation-delivery-enqueue',
      text: `INSERT INTO customer_access_deliveries(environment,id,mailbox_id,tenant_id,invitation_id,invitation_revision,
        purpose,payload_envelope,created_at,expires_at,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,'membership_invitation',$7::jsonb,$8,$8::timestamptz+interval '23 hours',$8)`,
      values: [environment,deliveryId,mailboxId,tenantId,invitationId,invitationRevision,JSON.stringify(envelope),now] });
  }
  async function issue(client,{ tenantId,intent: inputIntent,tenantDisplayName,now,recordAudit } = {}) {
    transaction(client);uuid(tenantId);const intent=normalizeCustomerInvitationIntent(inputIntent);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof recordAudit!=='function') {
      throw new TypeError('CUSTOMER_INVITATION_CUSTODY_INPUT_INVALID');
    }
    const mailboxId = await mailbox(client, intent.recipient), membershipId = nextId(), invitationId = nextId();
    const existing = await client.query({ name: 'customer-invitation-membership-existing',
      text: 'SELECT id FROM customer_access_memberships WHERE environment=$1 AND tenant_id=$2 AND mailbox_id=$3 FOR UPDATE',
      values: [environment,tenantId,mailboxId] });
    if (existing.rowCount) throw new CustomerInvitationConflictError();
    await client.query({ name: 'customer-invitation-membership-insert',
      text: 'INSERT INTO customer_access_memberships(environment,tenant_id,id,mailbox_id,created_at) VALUES($1,$2,$3,$4,$5)',
      values: [environment,tenantId,membershipId,mailboxId,now] });
    const auditId = await recordAudit({ invitationId,now });
    if (!/^[1-9]\d{0,18}$/.test(String(auditId)) || BigInt(auditId)>9223372036854775807n) {
      throw new Error('CUSTOMER_INVITATION_AUDIT_FAILED');
    }
    await client.query({ name: 'customer-invitation-insert',
      text: `INSERT INTO customer_member_invitations(environment,tenant_id,id,membership_id,mailbox_id,elevated_roles,locale,
        created_at,issued_at,expires_at,last_audit_event_id)
        VALUES($1,$2,$3,$4,$5,$6::varchar[],$7,$8,$8,$8::timestamptz+interval '7 days',$9)`,
      values: [environment,tenantId,invitationId,membershipId,mailboxId,intent.roles,intent.locale,now,auditId] });
    await delivery(client, { tenantId, invitationId, invitationRevision: 1, mailboxId,
      recipient: intent.recipient, tenantDisplayName, locale: intent.locale, now });
    return load(client, tenantId, invitationId);
  }
  return Object.freeze({ load,delivery,issue });
}
