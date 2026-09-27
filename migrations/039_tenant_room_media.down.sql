LOCK TABLE tenant_room_media_assets IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_room_media_assets LIMIT 1) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'TENANT_ROOM_MEDIA_REQUIRE_REVIEW';
  END IF;
END
$$;

DROP TABLE tenant_room_media_assets;
