-- Additive automatic technical ownership for ordinary synthetic Room imports.
-- Customer receives no direct private resource INSERT/UPDATE or Tenant status UPDATE.
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
  IF TG_OP<>'INSERT' OR pg_trigger_depth() NOT IN (1,2) OR NEW.revision<>1 OR NEW.environment NOT IN ('dev','int')
    OR (session_user::text<>('cm_protected_'||NEW.environment||'_platform') AND NOT (session_user::text=('cm_protected_'||NEW.environment||'_customer') AND pg_trigger_depth()=2)
      AND session_user::text<>current_user::text)
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

CREATE FUNCTION provision_synthetic_room_calendar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope record;
BEGIN
  IF TG_RELID<>'public.rooms'::regclass OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER'
    OR TG_OP<>'INSERT' OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_ROOM_TRIGGER_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF NOT NEW.active THEN RETURN NEW; END IF;
  SELECT registry.environment,generation.security_epoch,generation.id AS generation_id,integration.id AS integration_id
    INTO scope FROM public.tenant_runtime_registry registry
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id AND generation.state='active'
    JOIN public.integrations integration ON integration.tenant_id=registry.tenant_id
      AND integration.provider='synthetic_calendar' AND integration.provider_reference='synthetic:'||generation.id::text
      AND integration.status='active'
    WHERE registry.tenant_id=NEW.tenant_id AND registry.mode='synthetic' AND registry.environment IN ('dev','int');
  -- Preparing generations explicitly create technical resources after seeding.
  -- REAL/unclassified rooms never enter private synthetic provider state.
  IF NOT FOUND THEN RETURN NEW; END IF;
  INSERT INTO public.synthetic_calendar_resources(environment,security_epoch,tenant_id,generation_id,integration_id,room_id)
    VALUES(scope.environment,scope.security_epoch,NEW.tenant_id,scope.generation_id,scope.integration_id,NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION provision_synthetic_room_calendar() FROM PUBLIC;
CREATE TRIGGER synthetic_room_calendar_provision AFTER INSERT ON rooms
  FOR EACH ROW EXECUTE FUNCTION provision_synthetic_room_calendar();

CREATE FUNCTION protected_synthetic_lifecycle(scope_environment text,scope_epoch uuid,customer_session uuid,
  expected_status text,target_status text,locations_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_tenant uuid;target_generation uuid;current_status text;current_version bigint;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int') OR scope_epoch IS NULL
    OR customer_session IS NULL OR expected_status IS NULL OR target_status IS NULL OR locations_version IS NULL
    OR locations_version<1 OR NOT ((expected_status='onboarding' AND target_status='ready')
      OR (expected_status='ready' AND target_status='active'))
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    OR NOT public.protected_lock_synthetic_calendar_source(scope_environment,scope_epoch,customer_session) THEN RETURN false; END IF;
  SELECT custody.tenant_id,custody.generation_id INTO target_tenant,target_generation FROM public.synthetic_customer_handoffs custody
    JOIN public.tenant_runtime_registry registry ON registry.environment=custody.environment
      AND registry.tenant_id=custody.tenant_id AND registry.generation_id=custody.generation_id
      AND registry.operator_id=custody.operator_id AND registry.mode='synthetic' AND registry.slot=custody.slot
    JOIN public.synthetic_tenant_generations generation ON generation.environment=registry.environment
      AND generation.id=registry.generation_id AND generation.operator_id=registry.operator_id
      AND generation.security_epoch=scope_epoch AND generation.state='active'
      AND generation.operator_security_version=custody.operator_security_version
    WHERE custody.environment=scope_environment AND custody.security_epoch=scope_epoch
      AND custody.customer_session_id=customer_session AND custody.status='consumed' AND custody.selected_role='tenant_admin';
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT status,locations_revision INTO current_status,current_version FROM public.tenants
    WHERE id=target_tenant FOR UPDATE;
  IF current_status IS DISTINCT FROM expected_status OR current_version IS DISTINCT FROM locations_version THEN RETURN false; END IF;
  -- Readiness is actual local synthetic provider ownership, never Microsoft consent.
  IF EXISTS(SELECT 1 FROM public.rooms room JOIN public.sites site
    ON site.tenant_id=room.tenant_id AND site.id=room.site_id
    WHERE room.tenant_id=target_tenant AND room.active=true AND site.active=false) THEN RETURN false; END IF;
  PERFORM id FROM public.rooms WHERE tenant_id=target_tenant AND active=true ORDER BY id FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM resource.room_id FROM public.synthetic_calendar_resources resource
    JOIN public.integrations integration ON integration.tenant_id=resource.tenant_id AND integration.id=resource.integration_id
    WHERE resource.tenant_id=target_tenant ORDER BY resource.room_id FOR SHARE OF resource,integration;
  IF EXISTS(SELECT 1 FROM public.rooms room LEFT JOIN public.synthetic_calendar_resources resource
      ON resource.tenant_id=room.tenant_id AND resource.room_id=room.id
    LEFT JOIN public.integrations integration ON integration.tenant_id=resource.tenant_id AND integration.id=resource.integration_id
    WHERE room.tenant_id=target_tenant AND room.active=true AND (resource.room_id IS NULL
      OR resource.environment<>scope_environment OR resource.security_epoch<>scope_epoch OR resource.generation_id<>target_generation
      OR integration.provider IS DISTINCT FROM 'synthetic_calendar' OR integration.status IS DISTINCT FROM 'active'
      OR integration.provider_reference IS DISTINCT FROM 'synthetic:'||resource.generation_id::text)) THEN RETURN false; END IF;
  PERFORM capability_id FROM public.tenant_entitlements WHERE tenant_id=target_tenant
    AND capability_id IN ('microsoft.directory','microsoft.calendar') AND enabled=true ORDER BY capability_id FOR SHARE;
  IF (SELECT count(*) FROM public.tenant_entitlements WHERE tenant_id=target_tenant
      AND capability_id IN ('microsoft.directory','microsoft.calendar') AND enabled=true)<>2 THEN RETURN false; END IF;
  UPDATE public.tenants SET status=target_status,updated_at=GREATEST(updated_at,clock_timestamp())
    WHERE id=target_tenant AND status=expected_status AND locations_revision=locations_version;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION protected_synthetic_lifecycle(text,uuid,uuid,text,text,bigint) FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['cm_demo_customer','cm_demo_platform','cm_demo_reset'] LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.provision_synthetic_room_calendar(),public.protected_synthetic_lifecycle(text,uuid,uuid,text,text,bigint) FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
