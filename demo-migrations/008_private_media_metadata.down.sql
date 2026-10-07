LOCK TABLE demo_catalogue_media_assets IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM demo_catalogue_media_assets WHERE bytes IS NULL OR object_key IS NOT NULL) THEN
    RAISE EXCEPTION 'DEMO_PRIVATE_MEDIA_REQUIRE_VERIFIED_ROLLBACK';
  END IF;
END $$;
DROP INDEX demo_catalogue_media_object_key_idx;
ALTER TABLE demo_catalogue_media_assets
  DROP CONSTRAINT demo_catalogue_media_payload_required,
  DROP CONSTRAINT demo_catalogue_media_object_key,
  DROP COLUMN object_key,
  ALTER COLUMN bytes SET NOT NULL;
DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.media_object_inventory FROM %I, %I', customer_role, reset_role);
END $$;
