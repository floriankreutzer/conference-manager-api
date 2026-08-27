DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenants WHERE locations_revision <> 1)
     OR EXISTS (SELECT 1 FROM sites WHERE description IS NOT NULL OR sort_order <> 0)
     OR EXISTS (SELECT 1 FROM rooms WHERE description IS NOT NULL OR floor_label IS NOT NULL OR sort_order <> 0)
     OR EXISTS (SELECT 1 FROM room_service_availability)
     OR EXISTS (SELECT 1 FROM room_catering_package_availability) THEN
    RAISE EXCEPTION 'TENANT_LOCATION_SETTINGS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP TABLE room_catering_package_availability;
DROP TABLE room_service_availability;
ALTER TABLE rooms
  DROP CONSTRAINT rooms_floor_label_valid,
  DROP CONSTRAINT rooms_sort_order_valid,
  DROP COLUMN sort_order,
  DROP COLUMN floor_label,
  DROP COLUMN description;
ALTER TABLE sites
  DROP CONSTRAINT sites_sort_order_valid,
  DROP COLUMN sort_order,
  DROP COLUMN description;
