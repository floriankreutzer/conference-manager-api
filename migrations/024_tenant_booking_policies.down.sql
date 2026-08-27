DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE booking_policies_revision <> 1)
     OR EXISTS (SELECT 1 FROM tenant_booking_policies) THEN
    RAISE EXCEPTION 'TENANT_BOOKING_POLICIES_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE tenant_booking_policies;
