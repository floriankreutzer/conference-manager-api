DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_configuration_revisions WHERE change_kind <> 'initial' LIMIT 1
  ) THEN
    RAISE EXCEPTION 'TENANT_CONFIGURATION_REVISIONS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_brand_assets LIMIT 1) THEN
    RAISE EXCEPTION 'TENANT_BRAND_ASSETS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM sites WHERE details <> '{}'::jsonb LIMIT 1)
    OR EXISTS (SELECT 1 FROM rooms WHERE details <> '{}'::jsonb LIMIT 1)
    OR EXISTS (
      SELECT 1 FROM services
      WHERE description IS NOT NULL OR billing_unit <> 'per_booking' OR metadata <> '{}'::jsonb
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM catering_packages
      WHERE description IS NOT NULL
        OR billing_unit <> 'per_booking'
        OR metadata <> '{}'::jsonb
        OR item_ids <> '[]'::jsonb
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1 FROM catering_items
      WHERE description IS NOT NULL OR billing_unit <> 'per_unit' OR metadata <> '{}'::jsonb
      LIMIT 1
    )
  THEN
    RAISE EXCEPTION 'TENANT_CONFIGURATION_PROJECTIONS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE tenant_configuration_heads;
DROP TRIGGER tenant_configuration_revisions_immutable ON tenant_configuration_revisions;
DROP FUNCTION reject_tenant_configuration_revision_mutation();
DROP TABLE tenant_configuration_revisions;
DROP TABLE tenant_brand_assets;

ALTER TABLE catering_items
  DROP CONSTRAINT catering_items_metadata_object,
  DROP CONSTRAINT catering_items_billing_unit_valid,
  DROP COLUMN metadata,
  DROP COLUMN billing_unit,
  DROP COLUMN description;

ALTER TABLE catering_packages
  DROP CONSTRAINT catering_packages_item_ids_array,
  DROP CONSTRAINT catering_packages_metadata_object,
  DROP CONSTRAINT catering_packages_billing_unit_valid,
  DROP COLUMN item_ids,
  DROP COLUMN metadata,
  DROP COLUMN billing_unit,
  DROP COLUMN description;

ALTER TABLE services
  DROP CONSTRAINT services_metadata_object,
  DROP CONSTRAINT services_billing_unit_valid,
  DROP COLUMN metadata,
  DROP COLUMN billing_unit,
  DROP COLUMN description;

ALTER TABLE rooms
  DROP CONSTRAINT rooms_details_object,
  DROP COLUMN details;

ALTER TABLE sites
  DROP CONSTRAINT sites_details_object,
  DROP COLUMN details;
