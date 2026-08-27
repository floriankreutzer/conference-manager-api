DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE catalog_revision <> 1)
     OR EXISTS (SELECT 1 FROM services WHERE description IS NOT NULL OR billing_unit <> 'per_booking' OR sort_order <> 0)
     OR EXISTS (SELECT 1 FROM catering_packages WHERE description IS NOT NULL OR billing_unit <> 'per_booking' OR sort_order <> 0)
     OR EXISTS (SELECT 1 FROM catering_items WHERE description IS NOT NULL OR billing_unit <> 'per_unit' OR sort_order <> 0)
     OR EXISTS (SELECT 1 FROM catering_package_items) THEN
    RAISE EXCEPTION 'TENANT_CATALOG_SETTINGS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE catering_package_items;
ALTER TABLE catering_items
  DROP CONSTRAINT catering_items_billing_unit_valid,
  DROP CONSTRAINT catering_items_sort_order_valid,
  DROP COLUMN sort_order,
  DROP COLUMN billing_unit,
  DROP COLUMN description;
ALTER TABLE catering_packages
  DROP CONSTRAINT catering_packages_billing_unit_valid,
  DROP CONSTRAINT catering_packages_sort_order_valid,
  DROP COLUMN sort_order,
  DROP COLUMN billing_unit,
  DROP COLUMN description;
ALTER TABLE services
  DROP CONSTRAINT services_billing_unit_valid,
  DROP CONSTRAINT services_sort_order_valid,
  DROP COLUMN sort_order,
  DROP COLUMN billing_unit,
  DROP COLUMN description;
