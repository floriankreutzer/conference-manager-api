-- Removing the port retains all human, invitation, session and business history.
DROP FUNCTION protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint);
CREATE OR REPLACE FUNCTION protected_synthetic_lifecycle(scope_environment text,scope_epoch uuid,customer_session uuid,
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
DROP FUNCTION protected_apply_synthetic_lifecycle(text,uuid,uuid,uuid,text,text,bigint);
