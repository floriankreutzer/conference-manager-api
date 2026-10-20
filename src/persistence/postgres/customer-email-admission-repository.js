import { randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeCustomerEmailAdmissionSnapshot, matchesCustomerEmailAdmission } from '../../identity/customer-email-admission.js';
import { isCustomerEmailBrowserToken } from '../../identity/customer-email-browser-token.js';
import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { withPostgresTransaction } from './transaction.js';

const rejected = () => Object.freeze({ status: 'rejected' });
function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CUSTOMER_EMAIL_ADMISSION_INPUT_INVALID');
  return value.toLowerCase();
}
function currentEntry(member,invitation,user) {
  return { membershipId: member.id,tenantId: member.tenant_id,userId: member.user_id,
    userSecurityVersion: member.user_id === null ? null : Number(user.security_version),
    invitationId: member.user_id === null ? invitation.id : null,
    invitationRevision: member.user_id === null ? Number(invitation.revision) : null };
}

export function createPostgresCustomerEmailAdmissionRepository(pool,{ environment,flowBinding,auditRepository,
  identifierFactory = randomUUID } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function' || !['dev','int','prod'].includes(environment)
    || typeof flowBinding?.matchesBrowser !== 'function' || typeof flowBinding?.verifyCsrf !== 'function'
    || typeof auditRepository?.appendWithClient !== 'function' || typeof identifierFactory !== 'function') {
    throw new TypeError('CUSTOMER_EMAIL_ADMISSION_CONFIGURATION_INVALID');
  }
  function proof(value,browserToken,csrfToken,now) {
    const context = { challengeId: value?.id,purpose: 'choice' };
    return value && value.mailbox_id !== null && value.consumed_at === null
      && value.verified_at instanceof Date && value.expires_at instanceof Date
      && now.getTime()<Math.min(value.expires_at.getTime(),value.verified_at.getTime()+300_000)
      && flowBinding.matchesBrowser({ context,browserToken,browserVerifier: value.choice_verifier })
      && (csrfToken === undefined || flowBinding.verifyCsrf({ context,browserVerifier: value.choice_verifier,csrfToken }));
  }
  async function challenge(client,challengeId,lock = false) {
    const result = await client.query({ name: lock ? 'customer-email-admission-challenge-lock' : 'customer-email-admission-challenge-read',
      text: lock ? 'SELECT * FROM customer_email_challenges WHERE environment=$1 AND id=$2 FOR UPDATE'
        : 'SELECT * FROM customer_email_challenges WHERE environment=$1 AND id=$2',values: [environment,uuid(challengeId)] });
    return result.rows[0] ?? null;
  }
  async function now(client) {
    const value = (await client.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('CUSTOMER_EMAIL_ADMISSION_CLOCK_INVALID');
    return value;
  }
  async function append(client,input,event) {
    if (event.tenantId !== input.tenantId || event.actorUserId !== input.userId
      || event.correlationId !== input.correlationId) throw new Error('CUSTOMER_EMAIL_ADMISSION_AUDIT_INVALID');
    const stored = await auditRepository.appendWithClient(client,event);
    if (!stored || !/^[1-9]\d{0,18}$/.test(String(stored.id)) || stored.tenantId !== input.tenantId) {
      throw new Error('CUSTOMER_EMAIL_ADMISSION_AUDIT_FAILED');
    }
    return String(stored.id);
  }
  return Object.freeze({
    async choices({ challengeId,browserToken } = {}) {
      if (!isCustomerEmailBrowserToken(browserToken)) return rejected();
      const value = await challenge(pool,challengeId);
      if (!proof(value,browserToken,undefined,await now(pool))) return rejected();
      const snapshot = normalizeCustomerEmailAdmissionSnapshot(value.admission_snapshot),items = [];
      if (snapshot.length === 0) return rejected();
      const result = await pool.query({ name: 'customer-email-choice-current',text: `SELECT member.id,member.tenant_id,
          member.user_id,person.security_version,person.active,tenant.display_name,invitation.id AS invitation_id,
          invitation.revision,invitation.expires_at,invitation.accepted_at,invitation.revoked_at
          FROM customer_access_memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
          LEFT JOIN users person ON person.tenant_id=member.tenant_id AND person.id=member.user_id
          LEFT JOIN customer_member_invitations invitation ON invitation.environment=member.environment
            AND invitation.tenant_id=member.tenant_id AND invitation.membership_id=member.id AND member.user_id IS NULL
            AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
          WHERE member.environment=$1 AND member.mailbox_id=$2 AND member.id=ANY($3::uuid[])
            AND tenant.status IN ('pending','onboarding','ready','active')
            AND ((member.user_id IS NOT NULL AND person.active=true) OR (member.user_id IS NULL
              AND invitation.id IS NOT NULL AND invitation.expires_at>clock_timestamp()))
          ORDER BY member.tenant_id,member.id LIMIT 101`,
      values: [environment,value.mailbox_id,snapshot.map(item => item.membershipId)] });
      if (result.rows.length>100) return rejected();
      for (const row of result.rows) {
        const candidate = currentEntry(row,{ id: row.invitation_id,revision: row.revision },row);
        if (!matchesCustomerEmailAdmission({ snapshot,current: candidate })) continue;
        if (typeof row.display_name !== 'string' || row.display_name.length<1 || row.display_name.length>160
          || /[\u0000-\u001f\u007f]/.test(row.display_name)) throw new Error('CUSTOMER_EMAIL_CHOICE_LABEL_INVALID');
        items.push(Object.freeze({ membershipId: row.id,displayName: row.display_name }));
      }
      return Object.freeze({ status: 'membership_required',items: Object.freeze(items) });
    },
    async admit(input) {
      const { challengeId,browserToken,csrfToken,membershipId,correlationId,auditEventFor,issueSession } = input;
      uuid(challengeId); uuid(membershipId); uuid(correlationId);
      if (!isCustomerEmailBrowserToken(browserToken) || typeof csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(csrfToken)) {
        return rejected();
      }
      if (typeof auditEventFor !== 'function' || typeof issueSession !== 'function') {
        throw new TypeError('CUSTOMER_EMAIL_ADMISSION_PORT_REQUIRED');
      }
      const initial = await challenge(pool,challengeId);
      if (!proof(initial,browserToken,csrfToken,await now(pool))) return rejected();
      const snapshot = normalizeCustomerEmailAdmissionSnapshot(initial.admission_snapshot);
      const expected = snapshot.find(item => item.membershipId === membershipId.toLowerCase());
      if (!expected) return rejected();
      return withPostgresTransaction(pool,async client => {
        // Tenant -> membership -> User/invitation -> challenge. No global challenge
        // or mailbox lock is held while waiting for a Tenant business lock.
        const tenant = await client.query({ name: 'customer-email-admission-tenant-lock',text: `SELECT id FROM tenants
          WHERE id=$1 AND status IN ('pending','onboarding','ready','active') FOR UPDATE`,values: [expected.tenantId] });
        if (tenant.rowCount !== 1) return rejected();
        const membership = await client.query({ name: 'customer-email-admission-member-lock',text: `SELECT id,tenant_id,user_id,mailbox_id
          FROM customer_access_memberships WHERE environment=$1 AND tenant_id=$2 AND id=$3 AND mailbox_id=$4 FOR UPDATE`,
        values: [environment,expected.tenantId,expected.membershipId,initial.mailbox_id] });
        if (membership.rowCount !== 1) return rejected();
        const member = membership.rows[0]; let invitation = null,user = null;
        if (member.user_id === null) {
          const result = await client.query({ name: 'customer-email-admission-invitation-lock',text: `SELECT id,revision,elevated_roles,
            expires_at FROM customer_member_invitations WHERE environment=$1 AND tenant_id=$2 AND membership_id=$3
            AND mailbox_id=$4 AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
          values: [environment,expected.tenantId,member.id,member.mailbox_id] });
          if (result.rowCount !== 1) return rejected(); invitation = result.rows[0];
        } else {
          const result = await client.query({ name: 'customer-email-admission-user-lock',text: `SELECT id,security_version FROM users
            WHERE tenant_id=$1 AND id=$2 AND active=true FOR UPDATE`,values: [expected.tenantId,member.user_id] });
          if (result.rowCount !== 1) return rejected(); user = result.rows[0];
        }
        const value = await challenge(client,challengeId,true),time = await now(client);
        if (!proof(value,browserToken,csrfToken,time) || value.mailbox_id !== member.mailbox_id
          || (invitation && (!(invitation.expires_at instanceof Date) || invitation.expires_at<=time))
          || !matchesCustomerEmailAdmission({ snapshot: value.admission_snapshot,current: currentEntry(member,invitation,user) })) {
          return rejected();
        }
        let roles;
        if (invitation) {
          const userId = uuid(identifierFactory()); roles = [...invitation.elevated_roles];
          tenantAuthorizationSnapshot(['employee',...roles]);
          await client.query({ name: 'customer-email-admission-user-insert',text: `INSERT INTO users
            (tenant_id,id,display_name,active,created_at,updated_at) VALUES($1,$2,'Invited user',true,$3,$3)`,
          values: [expected.tenantId,userId,time] });
          await client.query({ name: 'customer-email-admission-binding-insert',text: `INSERT INTO user_identity_bindings
            (tenant_id,provider,provider_tenant_reference,provider_user_reference,user_id,created_at,updated_at)
            VALUES($1,'email_code',$2,$3,$4,$5,$5)`,values: [expected.tenantId,environment,member.mailbox_id,userId,time] });
          for (const role of roles) await client.query({ name: 'customer-email-admission-role-insert',text: `INSERT INTO tenant_user_roles
            (tenant_id,user_id,role,created_at,updated_at) VALUES($1,$2,$3,$4,$4)`,values: [expected.tenantId,userId,role,time] });
          const scope = { tenantId: expected.tenantId,userId,correlationId };
          await append(client,scope,auditEventFor({ ...scope,kind: 'provision',occurredAt: time.toISOString() }));
          const nextRevision = Number(invitation.revision)+1;
          const auditId = await append(client,scope,auditEventFor({ ...scope,kind: 'accept',invitationId: invitation.id,
            revision: nextRevision,occurredAt: time.toISOString() }));
          await client.query({ name: 'customer-email-admission-member-accept',text: `UPDATE customer_access_memberships
            SET user_id=$4,accepted_at=$5 WHERE environment=$1 AND tenant_id=$2 AND id=$3`,
          values: [environment,expected.tenantId,member.id,userId,time] });
          await client.query({ name: 'customer-email-admission-invitation-accept',text: `UPDATE customer_member_invitations
            SET revision=revision+1,accepted_at=$4,last_audit_event_id=$5 WHERE environment=$1 AND tenant_id=$2 AND id=$3`,
          values: [environment,expected.tenantId,invitation.id,time,auditId] });
          user = { id: userId,security_version: 1 };
        } else {
          const binding = await client.query({ name: 'customer-email-admission-binding-current',text: `SELECT user_id
            FROM user_identity_bindings WHERE tenant_id=$1 AND provider='email_code' AND provider_tenant_reference=$2
            AND provider_user_reference=$3 AND user_id=$4 FOR SHARE`,values: [expected.tenantId,environment,member.mailbox_id,user.id] });
          if (binding.rowCount !== 1) return rejected();
          const result = await client.query({ name: 'customer-email-admission-current-roles',text: `SELECT role FROM tenant_user_roles
            WHERE tenant_id=$1 AND user_id=$2 ORDER BY role`,values: [expected.tenantId,user.id] });
          roles = result.rows.map(item => item.role);
        }
        const authorization = tenantAuthorizationSnapshot(['employee',...roles]);
        const issued = await issueSession(Object.freeze({ tenantId: expected.tenantId,userId: user.id,
          securityVersion: Number(user.security_version),...authorization,
          providerIdentity: Object.freeze({ provider: 'email_code',reference: member.mailbox_id }) }));
        if (issued?.principal?.tenantId !== expected.tenantId || issued?.principal?.userId !== user.id
          || typeof issued.setCookie !== 'string') throw new Error('CUSTOMER_EMAIL_ADMISSION_SESSION_INVALID');
        await client.query({ name: 'customer-email-admission-consume',text: `UPDATE customer_email_challenges
          SET consumed_at=$3 WHERE environment=$1 AND id=$2`,values: [environment,value.id,time] });
        await client.query({ name: 'customer-email-admission-cancel-code',text: `UPDATE customer_access_deliveries
          SET status='cancelled' WHERE environment=$1 AND challenge_id=$2 AND status='queued'`,values: [environment,value.id] });
        return Object.freeze({ status: 'authenticated',setCookie: issued.setCookie });
      });
    },
  });
}
