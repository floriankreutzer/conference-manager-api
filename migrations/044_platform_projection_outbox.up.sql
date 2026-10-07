-- A coalescing outbox carries invalidation intent, never business payload or authority.
-- Rebuilds read authoritative current state; one row per Tenant bounds accumulation.
CREATE TABLE platform_projection_outbox (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  source_version bigint NOT NULL DEFAULT 1 CHECK (source_version >= 1),
  state varchar(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'poison')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  dirty_since timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failure varchar(32) CHECK (last_failure IS NULL OR last_failure = 'projection_failed')
);
CREATE INDEX platform_projection_outbox_due_idx
  ON platform_projection_outbox (available_at, tenant_id) WHERE state = 'pending';
REVOKE ALL ON TABLE platform_projection_outbox FROM PUBLIC;

CREATE FUNCTION enqueue_platform_projection_invalidation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  target_tenant uuid;
  changed_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    target_tenant := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN target_tenant := OLD.tenant_id;
  ELSE target_tenant := NEW.tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = target_tenant) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  INSERT INTO public.platform_projection_outbox (tenant_id, dirty_since, available_at)
    VALUES (target_tenant, changed_at, changed_at)
    ON CONFLICT (tenant_id) DO UPDATE SET
      source_version = public.platform_projection_outbox.source_version + 1,
      state = 'pending', attempts = 0, available_at = EXCLUDED.available_at, last_failure = NULL;
  UPDATE public.platform_tenant_readiness_snapshots
    SET readiness_state = 'stale',
      blocker_codes = ARRAY(SELECT DISTINCT code FROM unnest(blocker_codes || ARRAY['snapshot.invalidated']::text[]) code ORDER BY code),
      invalidated_at = GREATEST(changed_at, evaluated_at), invalidation_reason = 'source_state_changed',
      revision = revision + 1, updated_at = GREATEST(changed_at, updated_at)
    WHERE tenant_id = target_tenant AND invalidated_at IS NULL;
  UPDATE public.platform_microsoft_fleet_snapshots
    SET invalidated_at = GREATEST(changed_at, observed_at), invalidation_reason = 'source_state_changed',
      revision = revision + 1, updated_at = GREATEST(changed_at, updated_at)
    WHERE tenant_id = target_tenant AND invalidated_at IS NULL;
  -- Empty notifications are transaction-commit wakeups, never durable work or Tenant data.
  PERFORM pg_notify('cm_platform_projection', '');
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
REVOKE ALL PRIVILEGES ON FUNCTION enqueue_platform_projection_invalidation() FROM PUBLIC;

CREATE TRIGGER tenants_projection_outbox AFTER INSERT OR UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER identity_bindings_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON tenant_identity_bindings
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER onboarding_invitations_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON tenant_onboarding_invitations
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER integrations_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON integrations
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER entitlements_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON tenant_entitlements
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER room_mappings_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON microsoft365_room_mappings
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();
CREATE TRIGGER capability_health_projection_outbox AFTER INSERT OR UPDATE OR DELETE ON microsoft365_capability_health
  FOR EACH ROW EXECUTE FUNCTION enqueue_platform_projection_invalidation();

INSERT INTO platform_projection_outbox (tenant_id) SELECT id FROM tenants;
