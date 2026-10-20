DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_catalogue_media_assets LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_BUSINESS_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TABLE synthetic_catalogue_media_assets;
DROP FUNCTION guard_synthetic_catalogue_media();
DROP FUNCTION guard_synthetic_catalogue_media_truncate();

-- Restore the exact previous provider policy only after empty media recovery preconditions.
CREATE OR REPLACE FUNCTION guard_synthetic_tenant_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'PROTECTED_RUNTIME_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  PERFORM public.protected_runtime_acquire_exclusive(NEW.environment);
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'preparing' OR NEW.revision<>1 OR NOT EXISTS(
      SELECT 1 FROM public.platform_operators actor JOIN public.protected_runtime_deployments deployment
        ON deployment.environment=NEW.environment AND deployment.security_epoch=NEW.security_epoch
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra' AND actor.status='active'
        AND actor.security_version=NEW.operator_security_version)
      OR (SELECT count(*) FROM public.synthetic_tenant_generations
        WHERE environment=NEW.environment AND operator_id=NEW.operator_id)>=32 THEN
      RAISE EXCEPTION 'SYNTHETIC_GENERATION_CREATION_DENIED' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.environment,NEW.id,NEW.operator_id,NEW.operator_security_version,NEW.security_epoch,NEW.created_at)
      IS DISTINCT FROM (OLD.environment,OLD.id,OLD.operator_id,OLD.operator_security_version,OLD.security_epoch,OLD.created_at)
    OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='preparing' AND NEW.state IN ('active','archived')) OR (OLD.state='active' AND NEW.state='archived'))
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.state='preparing' AND NEW.state='archived' AND NEW.activated_at IS NOT NULL)
    OR NEW.activated_at>clock_timestamp()+interval '1 second' OR NEW.archived_at>clock_timestamp()+interval '1 second' THEN
    RAISE EXCEPTION 'SYNTHETIC_GENERATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  IF NEW.state='active' THEN
    IF NOT EXISTS(SELECT 1 FROM public.platform_operators actor JOIN public.protected_runtime_deployments deployment
      ON deployment.environment=NEW.environment AND deployment.security_epoch=NEW.security_epoch
      WHERE actor.id=NEW.operator_id AND actor.provider='microsoft_entra' AND actor.status='active'
        AND actor.security_version=NEW.operator_security_version)
      OR (SELECT count(*) FROM public.tenant_runtime_registry registry JOIN public.tenants tenant ON tenant.id=registry.tenant_id
        WHERE registry.environment=NEW.environment AND registry.generation_id=NEW.id
          AND tenant.status IN ('onboarding','ready','active'))<>3 THEN
      RAISE EXCEPTION 'SYNTHETIC_GENERATION_ACTIVATION_DENIED' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.tenant_runtime_registry registry JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    WHERE registry.environment=NEW.environment AND registry.generation_id=NEW.id AND tenant.status<>'archived') THEN
    RAISE EXCEPTION 'SYNTHETIC_GENERATION_REQUIRES_TENANT_ARCHIVAL' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
