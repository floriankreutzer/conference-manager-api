DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  IF EXISTS(SELECT 1 FROM public.synthetic_calendar_events LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.synthetic_calendar_resources LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  EXECUTE format('REVOKE TRUNCATE ON TABLE public.synthetic_calendar_events,public.synthetic_calendar_resources FROM %I',reset_role);
END $$;
