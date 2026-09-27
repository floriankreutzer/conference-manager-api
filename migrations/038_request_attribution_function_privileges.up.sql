LOCK TABLE requests, request_revisions, booking_change_requests IN ACCESS EXCLUSIVE MODE;

-- The marker mutates rollback evidence with the migration owner's authority. Keep it
-- callable only by that owner and enter it solely through the bounded trigger path.
REVOKE ALL PRIVILEGES ON FUNCTION public.mark_request_attribution_used() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.request_actor_display_name(tenant UUID, actor UUID)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT normalize(
    btrim(display_name, U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000'),
    NFC
  )
  FROM public.users WHERE tenant_id = tenant AND id = actor;
$$;

CREATE OR REPLACE FUNCTION public.preserve_requester_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requester_display_name := public.request_actor_display_name(
      NEW.tenant_id,
      NEW.requester_user_id
    );
    PERFORM public.mark_request_attribution_used();
  ELSIF NEW.requester_display_name IS DISTINCT FROM OLD.requester_display_name
    OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'REQUEST_ATTRIBUTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_request_revision_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL THEN
    IF NEW.actor_role_at_action IS NULL THEN
      RAISE EXCEPTION 'REQUEST_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW.actor_display_name := public.request_actor_display_name(
      NEW.tenant_id,
      NEW.actor_user_id
    );
    PERFORM public.mark_request_attribution_used();
  ELSE
    IF NEW.operation <> 'migrated_legacy' THEN
      RAISE EXCEPTION 'REQUEST_ACTOR_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW.actor_display_name := NULL;
    NEW.actor_role_at_action := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.preserve_booking_change_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.initiator_role_at_action IS NULL THEN
      RAISE EXCEPTION 'BOOKING_CHANGE_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW.initiator_display_name := public.request_actor_display_name(
      NEW.tenant_id,
      NEW.initiator_user_id
    );
    PERFORM public.mark_request_attribution_used();
  ELSIF NEW.initiator_display_name IS DISTINCT FROM OLD.initiator_display_name
    OR NEW.initiator_role_at_action IS DISTINCT FROM OLD.initiator_role_at_action
    OR NEW.initiator_user_id IS DISTINCT FROM OLD.initiator_user_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('applied', 'rejected', 'superseded')
    AND NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  IF NEW.decided_by_user_id IS NULL THEN
    NEW.decider_display_name := NULL;
    NEW.decider_role_at_action := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id THEN
    IF NEW.decider_role_at_action IS NULL THEN
      RAISE EXCEPTION 'BOOKING_CHANGE_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW.decider_display_name := public.request_actor_display_name(
      NEW.tenant_id,
      NEW.decided_by_user_id
    );
    PERFORM public.mark_request_attribution_used();
  ELSIF NEW.decider_display_name IS DISTINCT FROM OLD.decider_display_name
    OR NEW.decider_role_at_action IS DISTINCT FROM OLD.decider_role_at_action THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.preserve_requester_attribution() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.capture_request_revision_attribution() FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public.preserve_booking_change_attribution() FROM PUBLIC;
