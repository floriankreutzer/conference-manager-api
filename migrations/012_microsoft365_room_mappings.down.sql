DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM microsoft365_room_mappings LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back Microsoft 365 room mappings while mapping rows exist';
  END IF;
END
$$;

DROP TABLE microsoft365_room_mappings;
