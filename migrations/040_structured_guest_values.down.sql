DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sites WHERE guest_public_values IS NOT NULL)
    OR EXISTS (SELECT 1 FROM rooms WHERE guest_public_values IS NOT NULL)
    OR EXISTS (SELECT 1 FROM tenant_location_revisions
      WHERE guest_public_values <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'STRUCTURED_GUEST_VALUES_REQUIRE_REVIEW';
  END IF;
END;
$$;

ALTER TABLE rooms DROP COLUMN guest_public_values;
ALTER TABLE sites DROP COLUMN guest_public_values;
ALTER TABLE tenant_location_revisions DROP COLUMN guest_public_values;
