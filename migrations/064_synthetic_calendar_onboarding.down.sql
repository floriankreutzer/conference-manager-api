DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM synthetic_calendar_resources LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
END $$;
DROP TRIGGER synthetic_room_calendar_provision ON rooms;
DROP FUNCTION provision_synthetic_room_calendar();
DROP FUNCTION protected_synthetic_lifecycle(text,uuid,uuid,text,text,bigint);
CREATE OR REPLACE FUNCTION guard_synthetic_calendar_resource() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'public.synthetic_calendar_resources'::regclass OR TG_LEVEL<>'ROW' OR TG_WHEN<>'BEFORE' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    IF pg_trigger_depth()<>2 OR NEW.revision<>OLD.revision+1 OR
      (NEW.environment,NEW.security_epoch,NEW.tenant_id,NEW.generation_id,NEW.integration_id,NEW.room_id,NEW.created_at)
        IS DISTINCT FROM
      (OLD.environment,OLD.security_epoch,OLD.tenant_id,OLD.generation_id,OLD.integration_id,OLD.room_id,OLD.created_at) THEN
      RAISE EXCEPTION 'SYNTHETIC_CALENDAR_RESOURCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<>1 OR NEW.revision<>1 OR NEW.environment NOT IN ('dev','int')
    OR (session_user::text<>('cm_protected_'||NEW.environment||'_platform') AND session_user::text<>current_user::text)
    OR NOT pg_try_advisory_xact_lock_shared(740193,CASE NEW.environment WHEN 'dev' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_runtime_registry registry
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
    JOIN public.protected_runtime_deployments deployment ON deployment.environment=registry.environment
      AND deployment.security_epoch=generation.security_epoch
    JOIN public.platform_operators actor ON actor.id=registry.operator_id
      AND actor.security_version=generation.operator_security_version
    JOIN public.tenants tenant ON tenant.id=registry.tenant_id
    JOIN public.integrations integration ON integration.tenant_id=tenant.id AND integration.id=NEW.integration_id
    WHERE registry.environment=NEW.environment AND registry.tenant_id=NEW.tenant_id AND registry.mode='synthetic'
      AND registry.generation_id=NEW.generation_id AND generation.security_epoch=NEW.security_epoch
      AND generation.state IN ('preparing','active') AND actor.provider='microsoft_entra_platform' AND actor.status='active'
      AND tenant.status IN ('onboarding','ready','active')
      AND integration.provider='synthetic_calendar' AND integration.status='active'
      AND integration.provider_reference='synthetic:' || generation.id::text
    FOR SHARE OF generation,deployment,actor,tenant,integration;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
