-- Ops receives only the attribution facts required to classify verified Request
-- transitions. Customer records, names and free text stay outside this view.
CREATE VIEW demo_product_request_revision_facts WITH (security_barrier = true) AS
SELECT tenant_id, request_id, request_version, operation, captured_at,
  actor_role_at_action, record ->> 'status' AS request_status
FROM public.request_revisions;

-- This singleton is deliberately not part of the business reset inventory.
-- Replacing the audit stream advances it in the same transaction as the reset.
CREATE TABLE demo_product_source_epoch (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  source_epoch UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL
);
INSERT INTO demo_product_source_epoch (source_epoch, started_at)
VALUES (gen_random_uuid(), clock_timestamp());

CREATE FUNCTION advance_demo_product_source_epoch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'TRUNCATE' OR TG_LEVEL <> 'STATEMENT'
    OR TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'audit_events' THEN
    RAISE EXCEPTION 'DEMO_PRODUCT_EPOCH_TRIGGER_INVALID';
  END IF;
  UPDATE public.demo_product_source_epoch
    SET source_epoch = gen_random_uuid(), started_at = clock_timestamp()
    WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEMO_PRODUCT_EPOCH_REQUIRED'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION advance_demo_product_source_epoch() FROM PUBLIC;
CREATE TRIGGER audit_events_demo_product_epoch
AFTER TRUNCATE ON audit_events FOR EACH STATEMENT
EXECUTE FUNCTION advance_demo_product_source_epoch();

REVOKE ALL ON TABLE demo_product_request_revision_facts, demo_product_source_epoch FROM PUBLIC;
DO $$
DECLARE
  customer_role text := current_setting('conference_manager.demo_customer_role');
  platform_role text := current_setting('conference_manager.demo_platform_role');
  reset_role text := current_setting('conference_manager.demo_reset_role');
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.demo_product_request_revision_facts, '
    'public.demo_product_source_epoch FROM %I, %I, %I', customer_role, platform_role, reset_role);
  EXECUTE format('GRANT SELECT ON TABLE public.demo_product_request_revision_facts, '
    'public.demo_product_source_epoch TO %I', platform_role);
  EXECUTE format('GRANT SELECT ON TABLE public.demo_product_source_epoch TO %I', reset_role);
END $$;
