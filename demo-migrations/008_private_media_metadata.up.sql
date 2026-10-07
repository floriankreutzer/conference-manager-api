ALTER TABLE demo_catalogue_media_assets
  ALTER COLUMN bytes DROP NOT NULL,
  ADD COLUMN object_key varchar(192),
  ADD CONSTRAINT demo_catalogue_media_payload_required CHECK (bytes IS NOT NULL OR object_key IS NOT NULL),
  ADD CONSTRAINT demo_catalogue_media_object_key CHECK (
    object_key IS NULL OR object_key = 'v1/' || tenant_id::text || '/catalogue/'
      || id::text || '/' || encode(content_sha256, 'hex')
  );
CREATE INDEX demo_catalogue_media_object_key_idx ON demo_catalogue_media_assets (tenant_id, object_key)
  WHERE object_key IS NOT NULL;
DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  -- Overlay 001 enumerates canonical tables for reset custody. Narrow its inherited
  -- inventory grants explicitly: reset must never truncate durable orphan evidence.
  EXECUTE format('REVOKE ALL ON TABLE public.media_object_inventory FROM %I, %I', customer_role, reset_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.media_object_inventory TO %I, %I', customer_role, reset_role);
  -- Row locks require an UPDATE privilege. Only the immutable key column is granted;
  -- inventory mutation is additionally prohibited by the canonical immutable trigger.
  EXECUTE format('GRANT UPDATE (object_key) ON TABLE public.media_object_inventory TO %I, %I', customer_role, reset_role);
  EXECUTE format('GRANT UPDATE (object_key) ON TABLE public.demo_catalogue_media_assets TO %I', customer_role);
END $$;
