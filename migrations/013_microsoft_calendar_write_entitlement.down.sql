DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenant_entitlements
    WHERE capability_id = 'microsoft.calendar.write'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'MICROSOFT_CALENDAR_WRITE_ENTITLEMENT_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE tenant_entitlements
  DROP CONSTRAINT tenant_entitlements_capability_valid;

ALTER TABLE tenant_entitlements
  ADD CONSTRAINT tenant_entitlements_capability_valid CHECK (
    capability_id IN (
      'microsoft.directory',
      'microsoft.calendar'
    )
  );
