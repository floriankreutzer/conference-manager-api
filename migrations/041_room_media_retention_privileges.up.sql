-- Only the migration owner can execute this function until a dedicated maintenance role
-- is provisioned and granted EXECUTE in the target environment. Keep the owner non-login
-- for application traffic and resolve every relation through the fixed public schema.
CREATE FUNCTION public.prune_expired_unreferenced_room_media(
  p_tenant_id UUID, p_as_of TIMESTAMPTZ, p_limit INTEGER
)
RETURNS TABLE(deleted INTEGER, bytes BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_as_of IS NULL
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'ROOM_MEDIA_RETENTION_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- A caller-supplied future instant must not shorten the 30-day retention window.
  -- Uploads and Locations updates serialize on this same Tenant row.
  PERFORM 1 FROM public.tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::INTEGER, 0::BIGINT;
    RETURN;
  END IF;

  RETURN QUERY
  WITH removed AS (
    DELETE FROM public.tenant_room_media_assets asset
    WHERE asset.tenant_id = p_tenant_id
      AND asset.created_at < LEAST(p_as_of, clock_timestamp()) - INTERVAL '30 days'
      AND asset.id IN (
        SELECT candidate.id FROM public.tenant_room_media_assets candidate
        WHERE candidate.tenant_id = p_tenant_id
          AND candidate.created_at < LEAST(p_as_of, clock_timestamp()) - INTERVAL '30 days'
          AND NOT EXISTS (
            SELECT 1 FROM public.rooms room WHERE room.tenant_id = candidate.tenant_id
              AND (room.details->>'floorplanAssetId' = candidate.id::text
                OR COALESCE(room.details->'mediaAssetIds', '[]'::jsonb) ? candidate.id::text)
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.tenant_location_revisions revision
            CROSS JOIN LATERAL jsonb_array_elements(
              COALESCE(revision.configuration->'rooms', '[]'::jsonb)
            ) historic
            WHERE revision.tenant_id = candidate.tenant_id
              AND (historic->>'floorplanAssetId' = candidate.id::text
                OR COALESCE(historic->'mediaAssetIds', '[]'::jsonb) ? candidate.id::text)
          )
        ORDER BY candidate.created_at, candidate.id LIMIT p_limit
      )
    RETURNING asset.byte_length
  )
  SELECT count(*)::INTEGER, COALESCE(sum(removed.byte_length), 0)::BIGINT FROM removed;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.prune_expired_unreferenced_room_media(UUID, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
