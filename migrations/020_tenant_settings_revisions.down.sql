LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenants
    WHERE organization_revision <> 1
       OR locations_revision <> 1
       OR catalog_revision <> 1
       OR booking_policies_revision <> 1
       OR cost_allocation_revision <> 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_SETTINGS_REVISIONS_REQUIRE_REVIEW';
  END IF;
END $$;

ALTER TABLE tenants
  DROP CONSTRAINT tenants_organization_revision_valid,
  DROP CONSTRAINT tenants_locations_revision_valid,
  DROP CONSTRAINT tenants_catalog_revision_valid,
  DROP CONSTRAINT tenants_booking_policies_revision_valid,
  DROP CONSTRAINT tenants_cost_allocation_revision_valid,
  DROP COLUMN organization_revision,
  DROP COLUMN locations_revision,
  DROP COLUMN catalog_revision,
  DROP COLUMN booking_policies_revision,
  DROP COLUMN cost_allocation_revision;
