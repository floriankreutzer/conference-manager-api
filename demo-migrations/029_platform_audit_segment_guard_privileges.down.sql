DO $$
DECLARE platform_role text:=current_setting('conference_manager.demo_platform_role');
  reset_role text:=current_setting('conference_manager.demo_reset_role');
  customer_role text:=current_setting('conference_manager.demo_customer_role');
BEGIN
  IF EXISTS(SELECT 1 FROM public.platform_audit_segments) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000';
  END IF;
  EXECUTE format('REVOKE SELECT ON TABLE public.platform_audit_segments FROM %I,%I',platform_role,reset_role);
  EXECUTE format('REVOKE SELECT(id,environment,deployment_epoch) ON public.platform_audit_segments FROM %I',customer_role);
  EXECUTE format('REVOKE SELECT(segment_id,integrity_version) ON public.platform_audit_events FROM %I',customer_role);
END $$;
