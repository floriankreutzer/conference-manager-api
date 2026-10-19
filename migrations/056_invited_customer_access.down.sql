DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM customer_access_mailboxes LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_access_memberships LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_member_invitations LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_access_commands LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_email_challenges LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_access_deliveries LIMIT 1)
    OR EXISTS(SELECT 1 FROM customer_access_abuse_budgets LIMIT 1)
    OR EXISTS(SELECT 1 FROM audit_events WHERE target_type='customer_invitation' LIMIT 1)
  THEN RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TABLE customer_access_deliveries;
DROP TABLE customer_email_challenges;
DROP TABLE customer_access_commands;
DROP TABLE customer_member_invitations;
DROP TABLE customer_access_memberships;
DROP TABLE customer_access_mailboxes;
DROP TABLE customer_access_abuse_budgets;
DROP FUNCTION verify_customer_invitation_audit();
DROP FUNCTION guard_customer_access_custody();
DROP FUNCTION customer_access_envelope_valid(jsonb);
DROP FUNCTION customer_invitation_receipt_valid(jsonb);
