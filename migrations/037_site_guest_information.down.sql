LOCK TABLE sites IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_location_revisions IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sites WHERE guest_information IS NOT NULL LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM tenant_location_revisions
       WHERE guest_information IS NOT NULL AND guest_information <> '{}'::jsonb
       LIMIT 1
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'SITE_GUEST_INFORMATION_REQUIRE_REVIEW';
  END IF;
END
$$;

ALTER TABLE tenant_location_revisions DROP CONSTRAINT tenant_location_revisions_guest_information_object;
ALTER TABLE tenant_location_revisions DROP COLUMN guest_information;
ALTER TABLE sites DROP CONSTRAINT sites_guest_information_object;
ALTER TABLE sites DROP COLUMN guest_information;
