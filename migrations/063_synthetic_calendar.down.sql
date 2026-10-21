DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_calendar_events LIMIT 1)
    OR EXISTS(SELECT 1 FROM synthetic_calendar_resources LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TABLE synthetic_calendar_events;
DROP TABLE synthetic_calendar_resources;
DROP FUNCTION guard_synthetic_calendar_resource();
DROP FUNCTION guard_synthetic_calendar_event();
DROP FUNCTION guard_synthetic_calendar_truncate();
