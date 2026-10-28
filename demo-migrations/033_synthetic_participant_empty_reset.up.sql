DO $$
DECLARE reset_role text:=current_setting('conference_manager.demo_reset_role');
BEGIN
  -- The canonical immutable-history trigger denies nonempty participant history.
  -- Empty FK children still belong in the explicit existing Demo reset table set.
  EXECUTE format('GRANT TRUNCATE ON TABLE public.synthetic_invited_memberships TO %I',reset_role);
END $$;
