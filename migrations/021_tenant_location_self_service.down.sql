LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_location_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sites IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rooms IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_location_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM tenants WHERE locations_revision <> 1 LIMIT 1)
     OR EXISTS (SELECT 1 FROM sites WHERE details <> '{}'::jsonb LIMIT 1)
     OR EXISTS (SELECT 1 FROM rooms WHERE details <> '{}'::jsonb LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_LOCATION_HISTORY_REQUIRE_REVIEW';
  END IF;
END
$$;

DROP TRIGGER tenant_location_revisions_immutable_delete ON tenant_location_revisions;
DROP TRIGGER tenant_location_revisions_immutable_update ON tenant_location_revisions;
DROP FUNCTION reject_tenant_location_revision_mutation();
DROP TABLE tenant_location_revisions;

ALTER TABLE rooms DROP CONSTRAINT rooms_details_object;
ALTER TABLE rooms DROP COLUMN details;
ALTER TABLE sites DROP CONSTRAINT sites_details_object;
ALTER TABLE sites DROP COLUMN details;
