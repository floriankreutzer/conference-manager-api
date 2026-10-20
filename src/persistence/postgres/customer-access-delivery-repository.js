import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../../domain/invitation-recipient.js';
import { withPostgresTransaction } from './transaction.js';
import { lockCustomerDeliveryEligibility } from './customer-access-delivery-eligibility.js';
import { openCustomerMailbox } from './customer-invitation-records.js';

const invalid=() => { throw new Error('CUSTOMER_ACCESS_DELIVERY_CUSTODY_INVALID'); };
const due=`(status='queued' AND next_attempt_at<=clock_timestamp()
  OR status='claimed' AND lease_until<=clock_timestamp())`;
function uuid(value) { if (!isInternalUuid(value)) invalid();return value.toLowerCase(); }

export function createPostgresCustomerAccessDeliveryRepository(pool,{ environment,cipher,identifierFactory=randomUUID,
  tenantEligibility=null } = {}) {
  if (!pool || typeof pool.query!=='function' || typeof pool.connect!=='function' || !['dev','int','prod'].includes(environment)
    || !cipher || ['open','recipientLookup'].some(key => typeof cipher[key]!=='function') || typeof identifierFactory!=='function') {
    throw new TypeError('CUSTOMER_ACCESS_DELIVERY_CONFIGURATION_INVALID');
  }
  if (tenantEligibility!==null && typeof tenantEligibility?.allowsWithClient!=='function') {
    throw new TypeError('CUSTOMER_DELIVERY_TENANT_ELIGIBILITY_INVALID');
  }
  async function acquire(candidate) {
    return withPostgresTransaction(pool,async client => {
      const eligible=await lockCustomerDeliveryEligibility(client,environment,candidate,tenantEligibility);
      const locked=await client.query({ name: 'customer-delivery-claim-lock',text: `SELECT *,clock_timestamp() AS now
        FROM customer_access_deliveries WHERE environment=$1 AND id=$2 AND ${due} FOR UPDATE SKIP LOCKED`,
      values: [environment,uuid(candidate.id)] });
      if (locked.rowCount!==1) return null;
      const row=locked.rows[0],now=row.now;
      if (!(now instanceof Date) || !(row.expires_at instanceof Date) || !Number.isFinite(now.getTime())
        || row.mailbox_id!==candidate.mailbox_id || row.purpose!==candidate.purpose) invalid();
      if (!eligible || row.expires_at.getTime()<=now.getTime()+45000 || row.attempt_count>=5) {
        await client.query({ name: 'customer-delivery-expired-cancel',text: `UPDATE customer_access_deliveries
          SET status=$3,lease_id=NULL,lease_until=NULL WHERE environment=$1 AND id=$2`,
        values: [environment,row.id,row.attempt_count>=5 ? 'failed' : 'cancelled'] });
        return null;
      }
      const leaseId=uuid(identifierFactory());
      const mailbox=await client.query({ name: 'customer-delivery-mailbox-read',text: `SELECT id AS mailbox_id,
        lookup_hash,recipient_envelope FROM customer_access_mailboxes WHERE environment=$1 AND id=$2`,
      values: [environment,row.mailbox_id] });
      if (mailbox.rowCount!==1) invalid();
      const recipient=openCustomerMailbox(cipher,environment,mailbox.rows[0]);
      const bytes=cipher.open(row.payload_envelope,{ environment,mailboxId: row.mailbox_id,recordId: row.id,
        purpose: row.purpose,tenantId: row.tenant_id });
      let message;
      try {
        message=JSON.parse(bytes.toString('utf8'));
        if (!message || Object.keys(message).sort().join(',')!=='deliveryId,recipient,subject,text'
          || message.deliveryId!==row.id || normalizeInvitationRecipient(message.recipient)!==recipient) invalid();
      } finally { bytes.fill(0); }
      await client.query({ name: 'customer-delivery-claim',text: `UPDATE customer_access_deliveries
        SET status='claimed',attempt_count=attempt_count+1,lease_id=$3,lease_until=$4::timestamptz+interval '45 seconds'
        WHERE environment=$1 AND id=$2`,values: [environment,row.id,leaseId,now] });
      return Object.freeze({ deliveryId: row.id,leaseId,attemptCount: row.attempt_count+1,message: Object.freeze(message) });
    });
  }
  return Object.freeze({
    async claim() {
      const candidates=await pool.query({ name: 'customer-delivery-candidates',text: `SELECT id,mailbox_id,tenant_id,
        invitation_id,invitation_revision,challenge_id,purpose FROM customer_access_deliveries
        WHERE environment=$1 AND ${due} ORDER BY next_attempt_at,id LIMIT 20`,values: [environment] });
      if (candidates.rows.length>20) invalid();
      for (const row of candidates.rows) { const claimed=await acquire(row);if (claimed) return claimed; }
      return null;
    },
    async settle(value) {
      if (!value || Object.keys(value).sort().join(',')!=='deliveryId,leaseId,providerMessageId,retryDelayMs,status'
        || !['accepted','queued','failed'].includes(value.status)
        || (value.status==='accepted' ? !isInternalUuid(value.providerMessageId) : value.providerMessageId!==null)
        || (value.status==='queued' ? !Number.isSafeInteger(value.retryDelayMs) || value.retryDelayMs<1000
          || value.retryDelayMs>60000 : value.retryDelayMs!==null)) invalid();
      const deliveryId=uuid(value.deliveryId),leaseId=uuid(value.leaseId);
      return withPostgresTransaction(pool,async client => {
        const result=await client.query({ name: 'customer-delivery-settle',text: `UPDATE customer_access_deliveries SET
          status=CASE WHEN $4='queued' AND (attempt_count>=5 OR expires_at<=clock_timestamp()+($6::integer*interval '1 millisecond')
            +interval '45 seconds') THEN 'failed' ELSE $4 END,
          provider_message_id=$5,accepted_at=CASE WHEN $4='accepted' THEN clock_timestamp() ELSE NULL END,
          next_attempt_at=CASE WHEN $4='queued' THEN GREATEST(next_attempt_at,clock_timestamp()+($6::integer*interval '1 millisecond'))
            ELSE next_attempt_at END,lease_id=NULL,lease_until=NULL
          WHERE environment=$1 AND id=$2 AND status='claimed' AND lease_id=$3 RETURNING status`,
        values: [environment,deliveryId,leaseId,value.status,value.providerMessageId,value.retryDelayMs] });
        return result.rowCount===1 ? result.rows[0].status : null;
      });
    },
  });
}
