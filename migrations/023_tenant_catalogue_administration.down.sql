LOCK TABLE tenant_catalogue_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_item_room_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_item_site_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_package_room_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_package_site_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE equipment_room_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE equipment_site_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE service_room_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE service_site_applicability IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_package_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_package_variants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE equipment IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_items IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catering_packages IN ACCESS EXCLUSIVE MODE;
LOCK TABLE services IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE catalog_revision <> 1)
    OR EXISTS (SELECT 1 FROM tenant_catalogue_revisions WHERE revision <> 1)
    OR EXISTS (SELECT 1 FROM equipment)
    OR EXISTS (SELECT 1 FROM catering_package_variants)
    OR EXISTS (SELECT 1 FROM catering_package_items)
    OR EXISTS (SELECT 1 FROM service_site_applicability)
    OR EXISTS (SELECT 1 FROM service_room_applicability)
    OR EXISTS (SELECT 1 FROM equipment_site_applicability)
    OR EXISTS (SELECT 1 FROM equipment_room_applicability)
    OR EXISTS (SELECT 1 FROM catering_package_site_applicability)
    OR EXISTS (SELECT 1 FROM catering_package_room_applicability)
    OR EXISTS (SELECT 1 FROM catering_item_site_applicability)
    OR EXISTS (SELECT 1 FROM catering_item_room_applicability)
    OR EXISTS (SELECT 1 FROM services WHERE description IS NOT NULL OR sort_order <> 0)
    OR EXISTS (SELECT 1 FROM catering_packages WHERE description IS NOT NULL OR sort_order <> 0)
    OR EXISTS (SELECT 1 FROM catering_items WHERE description IS NOT NULL OR sort_order <> 0)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_CATALOGUE_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;

DROP TRIGGER tenants_initialize_catalogue_revision ON tenants;
DROP FUNCTION initialize_tenant_catalogue_revision();
DROP TRIGGER tenant_catalogue_revisions_append_only ON tenant_catalogue_revisions;
DROP TABLE tenant_catalogue_revisions;
DROP TABLE catering_item_room_applicability;
DROP TABLE catering_item_site_applicability;
DROP TABLE catering_package_room_applicability;
DROP TABLE catering_package_site_applicability;
DROP TABLE equipment_room_applicability;
DROP TABLE equipment_site_applicability;
DROP TABLE service_room_applicability;
DROP TABLE service_site_applicability;
DROP TABLE catering_package_items;
DROP TABLE catering_package_variants;
DROP TABLE equipment;

ALTER TABLE catering_items
  DROP CONSTRAINT catering_items_currency_supported,
  DROP CONSTRAINT catering_items_price_bounded,
  DROP CONSTRAINT catering_items_sort_order_valid,
  DROP CONSTRAINT catering_items_description_valid,
  DROP COLUMN sort_order,
  DROP COLUMN description;

ALTER TABLE catering_packages
  DROP CONSTRAINT catering_packages_currency_supported,
  DROP CONSTRAINT catering_packages_price_bounded,
  DROP CONSTRAINT catering_packages_sort_order_valid,
  DROP CONSTRAINT catering_packages_description_valid,
  DROP COLUMN sort_order,
  DROP COLUMN description;

ALTER TABLE services
  DROP CONSTRAINT services_currency_supported,
  DROP CONSTRAINT services_price_bounded,
  DROP CONSTRAINT services_sort_order_valid,
  DROP CONSTRAINT services_description_valid,
  DROP COLUMN sort_order,
  DROP COLUMN description;
