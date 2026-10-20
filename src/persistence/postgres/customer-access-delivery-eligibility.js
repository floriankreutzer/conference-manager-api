import { normalizeCustomerEmailAdmissionSnapshot } from '../../identity/customer-email-admission.js';

async function pendingInvitation(client,environment,delivery,tenantEligibility) {
  if (tenantEligibility && await tenantEligibility.allowsWithClient(client,delivery.tenant_id)!==true) return false;
  const tenant=await client.query({ name: 'customer-delivery-tenant-lock',text: `SELECT id FROM tenants
    WHERE id=$1 AND status IN ('pending','onboarding','ready','active') FOR SHARE`,values: [delivery.tenant_id] });
  if (tenant.rowCount!==1) return false;
  const member=await client.query({ name: 'customer-delivery-pending-member-lock',text: `SELECT member.id
    FROM customer_access_memberships member JOIN customer_member_invitations invitation
      ON invitation.environment=member.environment AND invitation.tenant_id=member.tenant_id
      AND invitation.membership_id=member.id AND invitation.mailbox_id=member.mailbox_id
    WHERE member.environment=$1 AND member.tenant_id=$2 AND member.mailbox_id=$3
      AND member.user_id IS NULL AND invitation.id=$4 FOR SHARE OF member`,
  values: [environment,delivery.tenant_id,delivery.mailbox_id,delivery.invitation_id] });
  if (member.rowCount!==1) return false;
  const invitation=await client.query({ name: 'customer-delivery-invitation-lock',text: `SELECT id
    FROM customer_member_invitations WHERE environment=$1 AND tenant_id=$2 AND id=$3 AND mailbox_id=$4
      AND revision=$5 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
  values: [environment,delivery.tenant_id,delivery.invitation_id,delivery.mailbox_id,delivery.invitation_revision] });
  return invitation.rowCount===1;
}

async function capturedMember(client,environment,mailboxId,entry,tenantEligibility) {
  if (tenantEligibility && await tenantEligibility.allowsWithClient(client,entry.tenantId)!==true) return false;
  const tenant=await client.query({ name: 'customer-delivery-code-tenant-lock',text: `SELECT id FROM tenants
    WHERE id=$1 AND status IN ('pending','onboarding','ready','active') FOR SHARE`,values: [entry.tenantId] });
  if (tenant.rowCount!==1) return false;
  const member=await client.query({ name: 'customer-delivery-code-member-lock',text: `SELECT user_id
    FROM customer_access_memberships WHERE environment=$1 AND tenant_id=$2 AND id=$3 AND mailbox_id=$4 FOR SHARE`,
  values: [environment,entry.tenantId,entry.membershipId,mailboxId] });
  if (member.rowCount!==1 || member.rows[0].user_id!==entry.userId) return false;
  if (entry.userId===null) {
    const invitation=await client.query({ name: 'customer-delivery-code-invitation-lock',text: `SELECT id
      FROM customer_member_invitations WHERE environment=$1 AND tenant_id=$2 AND membership_id=$3 AND id=$4
        AND mailbox_id=$5 AND revision=$6 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at>clock_timestamp() FOR SHARE`,
    values: [environment,entry.tenantId,entry.membershipId,entry.invitationId,mailboxId,entry.invitationRevision] });
    return invitation.rowCount===1;
  }
  const user=await client.query({ name: 'customer-delivery-code-user-lock',text: `SELECT id FROM users
    WHERE tenant_id=$1 AND id=$2 AND active=true AND security_version=$3 FOR SHARE`,
  values: [entry.tenantId,entry.userId,entry.userSecurityVersion] });
  if (user.rowCount!==1) return false;
  const binding=await client.query({ name: 'customer-delivery-code-binding-lock',text: `SELECT user_id
    FROM user_identity_bindings WHERE tenant_id=$1 AND provider='email_code' AND provider_tenant_reference=$2
      AND provider_user_reference=$3 AND user_id=$4 FOR SHARE`,values: [entry.tenantId,environment,mailboxId,entry.userId] });
  return binding.rowCount===1;
}

// Authority locks precede challenge and delivery locks, matching admission and
// invitation mutation order. This port never admits members or changes roles.
export async function lockCustomerDeliveryEligibility(client,environment,delivery,tenantEligibility=null) {
  if (tenantEligibility!==null && typeof tenantEligibility?.allowsWithClient!=='function') {
    throw new TypeError('CUSTOMER_DELIVERY_TENANT_ELIGIBILITY_INVALID');
  }
  if (delivery.purpose==='membership_invitation') return pendingInvitation(client,environment,delivery,tenantEligibility);
  if (delivery.purpose!=='mailbox_code') throw new Error('CUSTOMER_ACCESS_DELIVERY_CUSTODY_INVALID');
  const initial=await client.query({ name: 'customer-delivery-code-snapshot',text: `SELECT admission_snapshot
    FROM customer_email_challenges WHERE environment=$1 AND id=$2 AND mailbox_id=$3`,
  values: [environment,delivery.challenge_id,delivery.mailbox_id] });
  if (initial.rowCount!==1) return false;
  const snapshot=normalizeCustomerEmailAdmissionSnapshot(initial.rows[0].admission_snapshot);
  let eligible=false;
  for (const entry of [...snapshot].sort((a,b) => a.tenantId.localeCompare(b.tenantId))) {
    if (await capturedMember(client,environment,delivery.mailbox_id,entry,tenantEligibility)) { eligible=true;break; }
  }
  const challenge=await client.query({ name: 'customer-delivery-code-challenge-lock',text: `SELECT id
    FROM customer_email_challenges WHERE environment=$1 AND id=$2 AND mailbox_id=$3
      AND consumed_at IS NULL AND verified_at IS NULL AND attempt_count<5 AND expires_at>clock_timestamp() FOR UPDATE`,
  values: [environment,delivery.challenge_id,delivery.mailbox_id] });
  return eligible && challenge.rowCount===1;
}
