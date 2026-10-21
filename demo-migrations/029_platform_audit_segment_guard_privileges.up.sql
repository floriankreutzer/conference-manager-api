DO $$
DECLARE platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
  customer_role text:=current_setting('conference_manager.demo_customer_role');
BEGIN
  -- Only observe the transition fence. Demo receives no segment signing/reset rights.
  EXECUTE format('GRANT SELECT ON TABLE public.platform_audit_segments TO %I,%I',platform_role,reset_role);
  EXECUTE format('GRANT SELECT(id,environment,deployment_epoch) ON public.platform_audit_segments TO %I',customer_role);
  EXECUTE format('GRANT SELECT(segment_id,integrity_version) ON public.platform_audit_events TO %I',customer_role);
END $$;
