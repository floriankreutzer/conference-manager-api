ALTER TABLE tenant_room_media_assets
  ALTER COLUMN bytes DROP NOT NULL,
  ADD COLUMN object_key varchar(192),
  DROP CONSTRAINT tenant_room_media_bytes,
  ADD CONSTRAINT tenant_room_media_bytes CHECK (
    byte_length BETWEEN 1 AND 2097152
    AND (bytes IS NOT NULL OR object_key IS NOT NULL)
    AND (bytes IS NULL OR octet_length(bytes) = byte_length)
  ),
  ADD CONSTRAINT tenant_room_media_object_key CHECK (
    object_key IS NULL OR object_key = 'v1/' || tenant_id::text || '/room/'
      || id::text || '/' || encode(content_sha256, 'hex')
  );

CREATE INDEX tenant_room_media_object_key_idx ON tenant_room_media_assets (tenant_id, object_key)
  WHERE object_key IS NOT NULL;

-- No Tenant FK: reset/Tenant deletion must retain orphan cleanup and restore evidence.
-- Runtime roles may register immutable intents but cannot alter/delete inventory records.
CREATE TABLE media_object_inventory (
  object_key varchar(192) PRIMARY KEY,
  tenant_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  kind varchar(16) NOT NULL CHECK (kind IN ('room', 'catalogue')),
  content_type varchar(16) NOT NULL CHECK (content_type IN ('image/png', 'image/webp')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 2097152),
  content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (kind <> 'room' OR content_type = 'image/webp'),
  CHECK (object_key = 'v1/' || tenant_id::text || '/' || kind || '/'
    || asset_id::text || '/' || encode(content_sha256, 'hex'))
);
CREATE INDEX media_object_inventory_retention_idx ON media_object_inventory (registered_at, object_key);
CREATE INDEX media_object_inventory_tenant_idx ON media_object_inventory (tenant_id, object_key);
REVOKE ALL ON TABLE media_object_inventory FROM PUBLIC;

CREATE FUNCTION prevent_media_inventory_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'MEDIA_OBJECT_INVENTORY_IMMUTABLE';
END $$;
REVOKE ALL ON FUNCTION prevent_media_inventory_mutation() FROM PUBLIC;
CREATE TRIGGER media_object_inventory_immutable BEFORE UPDATE ON media_object_inventory
FOR EACH ROW EXECUTE FUNCTION prevent_media_inventory_mutation();
