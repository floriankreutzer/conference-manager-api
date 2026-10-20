import { randomUUID } from 'node:crypto';
import { normalizeCustomerInvitationBatch } from '../../authorization/customer-invitation-policy.js';
import { CustomerInvitationConflictError } from '../../domain/customer-invitation-errors.js';
import { withPostgresTransaction } from './transaction.js';
import { createCustomerInvitationCustody } from './customer-invitation-custody.js';
import { customerInvitationUuid as uuid, customerInvitationActor, lockCustomerInvitationActor,
  customerInvitationDenied, customerInvitationRecord,
  CUSTOMER_INVITATION_COLUMNS, CUSTOMER_INVITATION_JOINS } from './customer-invitation-records.js';

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('CUSTOMER_INVITATION_REVISION_INVALID');
  }
  return value;
}
async function databaseTime(client) {
  const result = await client.query('SELECT clock_timestamp() AS now');
  if (!(result.rows[0]?.now instanceof Date)) throw new TypeError('CUSTOMER_INVITATION_CLOCK_INVALID');
  return result.rows[0].now;
}

export function createPostgresCustomerInvitationRepository(pool, {
  environment, cipher, content, auditRepository, identifierFactory = randomUUID,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || !['dev','int','prod'].includes(environment)
    || !cipher || ['seal','open','recipientLookup','commandDigest'].some(method => typeof cipher[method] !== 'function')
    || !content || typeof content.invitation !== 'function' || !auditRepository || typeof auditRepository.appendWithClient !== 'function'
    || typeof identifierFactory !== 'function') throw new TypeError('CUSTOMER_INVITATION_REPOSITORY_CONFIGURATION_INVALID');
  const { load,delivery,issue }=createCustomerInvitationCustody(pool,{ environment,cipher,content,identifierFactory });
  async function audit(client, input, invitationId, nextRevision, now) {
    if (typeof input.auditEventFor !== 'function') throw new TypeError('CUSTOMER_INVITATION_AUDIT_REQUIRED');
    const event = input.auditEventFor({ invitationId, nextRevision, occurredAt: now.toISOString() });
    const stored = await auditRepository.appendWithClient(client, event);
    if (!stored || !stored.id || stored.tenantId !== input.tenantId) throw new Error('CUSTOMER_INVITATION_AUDIT_FAILED');
    const identifier = String(stored.id);
    if (!/^[1-9]\d{0,18}$/.test(identifier) || BigInt(identifier)>9223372036854775807n) {
      throw new Error('CUSTOMER_INVITATION_AUDIT_FAILED');
    }
    return identifier;
  }
  async function mutate(input, operation) {
    const actor = customerInvitationActor(input, environment), invitationId = uuid(input.invitationId);
    const expected = revision(input.expectedRevision);
    return withPostgresTransaction(pool, async client => {
      const tenantDisplayName = await lockCustomerInvitationActor(client, actor), now = await databaseTime(client);
      const result = await client.query({ name: 'customer-invitation-mutation-lock',
        text: `SELECT invitation.revision,invitation.issued_at,invitation.accepted_at,invitation.revoked_at,
          invitation.locale,invitation.mailbox_id,membership.user_id FROM customer_member_invitations invitation
          JOIN customer_access_memberships membership ON membership.environment=invitation.environment
            AND membership.tenant_id=invitation.tenant_id AND membership.id=invitation.membership_id
          WHERE invitation.environment=$1 AND invitation.tenant_id=$2 AND invitation.id=$3
          FOR UPDATE OF invitation,membership`, values: [environment,actor.tenantId,invitationId] });
      if (result.rowCount !== 1) customerInvitationDenied();
      const current = result.rows[0];
      if (Number(current.revision) !== expected || current.accepted_at !== null || current.revoked_at !== null
        || current.user_id !== null || expected >= Number.MAX_SAFE_INTEGER - 1) throw new CustomerInvitationConflictError();
      if (operation === 'reissue' && now.getTime() - current.issued_at.getTime() < 60000) {
        throw new CustomerInvitationConflictError();
      }
      const nextRevision = expected + 1, auditId = await audit(client, input, invitationId, nextRevision, now);
      await client.query({ name: 'customer-invitation-cancel-queued',
        text: `UPDATE customer_access_deliveries SET status='cancelled' WHERE environment=$1 AND tenant_id=$2
          AND invitation_id=$3 AND status='queued'`, values: [environment,actor.tenantId,invitationId] });
      if (operation === 'reissue') {
        await client.query({ name: 'customer-invitation-reissue',
          text: `UPDATE customer_member_invitations SET revision=$4,issued_at=$5,expires_at=$5::timestamptz+interval '7 days',
            last_audit_event_id=$6 WHERE environment=$1 AND tenant_id=$2 AND id=$3`,
          values: [environment,actor.tenantId,invitationId,nextRevision,now,auditId] });
        const value = await load(client, actor.tenantId, invitationId);
        await delivery(client, { tenantId: actor.tenantId, invitationId, invitationRevision: nextRevision,
          mailboxId: current.mailbox_id, recipient: value.recipient, tenantDisplayName, locale: current.locale, now });
      } else {
        await client.query({ name: 'customer-invitation-revoke',
          text: `UPDATE customer_member_invitations SET revision=$4,revoked_at=$5,last_audit_event_id=$6
            WHERE environment=$1 AND tenant_id=$2 AND id=$3`,
          values: [environment,actor.tenantId,invitationId,nextRevision,now,auditId] });
      }
      return load(client, actor.tenantId, invitationId);
    });
  }
  return Object.freeze({
    async list(input) {
      const actor = customerInvitationActor(input, environment), limit = input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('CUSTOMER_INVITATION_LIMIT_INVALID');
      const after = input.afterInvitationId === null ? null : uuid(input.afterInvitationId);
      return withPostgresTransaction(pool, async client => {
        await lockCustomerInvitationActor(client, actor);
        const result = await client.query({ name: 'customer-invitation-list',
          text: `SELECT ${CUSTOMER_INVITATION_COLUMNS} FROM customer_member_invitations invitation ${CUSTOMER_INVITATION_JOINS}
            WHERE invitation.environment=$1 AND invitation.tenant_id=$2 AND ($3::uuid IS NULL OR invitation.id>$3::uuid)
            ORDER BY invitation.id LIMIT $4`, values: [environment,actor.tenantId,after,limit] });
        return Object.freeze(result.rows.map(row => customerInvitationRecord(cipher, environment, row)));
      });
    },
    async issueBatch(input) {
      const actor = customerInvitationActor(input, environment);
      const normalized = normalizeCustomerInvitationBatch({ commandId: input.commandId, invitations: input.invitations });
      const digestBytes = Buffer.from(JSON.stringify(normalized.invitations), 'utf8');
      let hash;
      try { hash = cipher.commandDigest(digestBytes, { tenantId: actor.tenantId, commandId: normalized.commandId,
        actorType: 'customer', actorId: actor.principal.userId }); } finally { digestBytes.fill(0); }
      return withPostgresTransaction(pool, async client => {
        const tenantDisplayName = await lockCustomerInvitationActor(client, actor);
        const receipt = await client.query({ name: 'customer-invitation-command-read',
          text: `SELECT command_hash,actor_user_id,result FROM customer_access_commands
            WHERE environment=$1 AND tenant_id=$2 AND id=$3 FOR UPDATE`, values: [environment,actor.tenantId,normalized.commandId] });
        if (receipt.rowCount) {
          const previous = receipt.rows[0];
          if (previous.command_hash !== hash || previous.actor_user_id !== actor.principal.userId
            || !Array.isArray(previous.result) || previous.result.length !== normalized.invitations.length) {
            throw new CustomerInvitationConflictError();
          }
          const restored = [];
          for (const snapshot of previous.result) {
            const fields = ['id','revision','roles','locale','state','expiresAt','delivery'];
            if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
              || Object.keys(snapshot).length !== fields.length || Object.keys(snapshot).some(key => !fields.includes(key))) {
              throw new TypeError('CUSTOMER_INVITATION_RECEIPT_INVALID');
            }
            const current = await load(client, actor.tenantId, uuid(snapshot.id));
            restored.push(Object.freeze({ tenantId: actor.tenantId, environment, ...snapshot, recipient: current.recipient }));
          }
          return Object.freeze(restored);
        }
        const now = await databaseTime(client), stored = [];
        const ordered = normalized.invitations.map((intent,index) => ({ intent,index,hash: cipher.recipientLookup(intent.recipient) }))
          .sort((left,right) => left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0);
        for (const { intent,index } of ordered) {
          stored[index] = await issue(client,{ tenantId: actor.tenantId,intent,tenantDisplayName,now,
            recordAudit: ({ invitationId,now: issuedAt }) => audit(client,input,invitationId,1,issuedAt) });
        }
        const receipts = stored.map(({ id, revision: version, roles, locale, state, expiresAt, delivery: deliveryState }) => ({
          id, revision: version, roles, locale, state, expiresAt, delivery: deliveryState,
        }));
        await client.query({ name: 'customer-invitation-command-insert',
          text: `INSERT INTO customer_access_commands(environment,tenant_id,id,actor_user_id,command_hash,result,created_at)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          values: [environment,actor.tenantId,normalized.commandId,actor.principal.userId,hash,JSON.stringify(receipts),now] });
        return Object.freeze(stored);
      });
    },
    reissue(input) { return mutate(input, 'reissue'); },
    revoke(input) { return mutate(input, 'revoke'); },
  });
}
