LOCK TABLE tenant_room_media_assets, media_object_inventory IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_room_media_assets WHERE bytes IS NULL OR object_key IS NOT NULL)
    OR EXISTS (SELECT 1 FROM media_object_inventory) THEN
    RAISE EXCEPTION 'PRIVATE_MEDIA_OBJECTS_REQUIRE_VERIFIED_ROLLBACK';
  END IF;
END $$;
DROP TABLE media_object_inventory;
DROP FUNCTION prevent_media_inventory_mutation();
DROP INDEX tenant_room_media_object_key_idx;
ALTER TABLE tenant_room_media_assets
  DROP CONSTRAINT tenant_room_media_object_key,
  DROP CONSTRAINT tenant_room_media_bytes,
  DROP COLUMN object_key,
  ALTER COLUMN bytes SET NOT NULL,
  ADD CONSTRAINT tenant_room_media_bytes CHECK (
    byte_length BETWEEN 1 AND 2097152 AND octet_length(bytes) = byte_length
  );
