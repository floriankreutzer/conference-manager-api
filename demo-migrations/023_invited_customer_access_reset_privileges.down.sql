DO $$
DECLARE
  customer_role text:=current_setting('conference_manager.demo_customer_role');
  platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.customer_access_deliveries,public.customer_email_challenges,public.customer_access_commands,public.customer_member_invitations,public.customer_access_memberships,public.customer_access_mailboxes,public.customer_access_abuse_budgets FROM %I,%I,%I',customer_role,platform_role,reset_role);
END $$;
