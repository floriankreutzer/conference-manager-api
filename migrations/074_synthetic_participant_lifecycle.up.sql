-- Shared readiness mutation stays private to the separately qualified source wrappers.
CREATE FUNCTION protected_apply_synthetic_lifecycle(scope_environment text,scope_epoch uuid,
  target_tenant uuid,target_generation uuid,expected_status text,target_status text,locations_version bigint) RETURNS boolean
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE current_status text;current_version bigint;
BEGIN
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
REVOKE ALL ON FUNCTION protected_apply_synthetic_lifecycle(text,uuid,uuid,uuid,text,text,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION protected_synthetic_lifecycle(scope_environment text,scope_epoch uuid,customer_session uuid,
  expected_status text,target_status text,locations_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_tenant uuid;target_generation uuid;
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
  RETURN public.protected_apply_synthetic_lifecycle(scope_environment,scope_epoch,target_tenant,target_generation,
    expected_status,target_status,locations_version);
END $$;

-- Human participants use current accepted membership, not a delegated Platform session.
-- This narrow wrapper grants no general Tenant/Platform UPDATE authority.
CREATE FUNCTION protected_synthetic_participant_lifecycle(scope_environment text,scope_epoch uuid,customer_session uuid,
  expected_status text,target_status text,locations_version bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE target_tenant uuid;target_member uuid;target_generation uuid;target_user uuid;person_version bigint;
BEGIN
  IF scope_environment IS NULL OR scope_environment NOT IN ('dev','int') OR scope_epoch IS NULL
    OR customer_session IS NULL OR expected_status IS NULL OR target_status IS NULL OR locations_version IS NULL
    OR locations_version<1 OR NOT ((expected_status='onboarding' AND target_status='ready')
      OR (expected_status='ready' AND target_status='active'))
    OR (session_user::text<>('cm_protected_'||scope_environment||'_customer') AND session_user::text<>current_user::text)
    THEN RETURN false; END IF;
  SELECT member.tenant_id,member.id,session.user_id,session.principal_version
    INTO target_tenant,target_member,target_user,person_version
    FROM public.sessions session JOIN public.customer_access_memberships member
      ON member.tenant_id=session.tenant_id AND member.user_id=session.user_id AND member.environment=scope_environment
      AND member.accepted_at IS NOT NULL
    WHERE session.id=customer_session AND session.provider IN ('email_code','microsoft_entra')
      AND session.revoked_at IS NULL AND session.issued_at<=clock_timestamp() AND session.expires_at>clock_timestamp();
  IF NOT FOUND OR NOT public.protected_lock_synthetic_participant_scope(scope_environment,scope_epoch,
    target_tenant,target_member,NULL,true) THEN RETURN false; END IF;
  -- The member/generation function retains deployment, owner and Tenant locks.
  -- Re-read actual identity and current Admin provenance after those locks.
  PERFORM person.id FROM public.users person JOIN public.sessions session
    ON session.tenant_id=person.tenant_id AND session.user_id=person.id AND session.id=customer_session
    JOIN public.customer_access_memberships member ON member.environment=scope_environment AND member.tenant_id=person.tenant_id
      AND member.id=target_member AND member.user_id=person.id AND member.accepted_at IS NOT NULL
    JOIN public.user_identity_bindings identity ON identity.tenant_id=person.tenant_id AND identity.user_id=person.id
      AND identity.provider=session.provider
    WHERE person.tenant_id=target_tenant AND person.id=target_user AND person.active=true
      AND person.security_version=person_version AND session.principal_version=person_version
      AND session.revoked_at IS NULL AND session.issued_at<=clock_timestamp() AND session.expires_at>clock_timestamp()
      AND 'tenant_admin'=ANY(session.roles) AND 'tenant:integrations:manage'=ANY(session.permissions)
      AND EXISTS(SELECT 1 FROM public.tenant_user_roles elevation WHERE elevation.tenant_id=person.tenant_id AND elevation.user_id=person.id
        AND elevation.role='tenant_admin' AND public.tenant_role_source_active(elevation.direct_grant,elevation.microsoft_verified_until))
      AND ((session.provider='email_code' AND identity.provider_tenant_reference=scope_environment
        AND identity.provider_user_reference=member.mailbox_id::text AND session.provider_identity_reference=member.mailbox_id::text)
        OR (session.provider='microsoft_entra' AND session.provider_identity_reference=
          identity.provider_tenant_reference||':'||identity.provider_user_reference))
    FOR SHARE OF person,session,member NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT participant.generation_id INTO target_generation FROM public.synthetic_invited_memberships participant
    WHERE participant.environment=scope_environment AND participant.tenant_id=target_tenant AND participant.membership_id=target_member;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN public.protected_apply_synthetic_lifecycle(scope_environment,scope_epoch,target_tenant,target_generation,
    expected_status,target_status,locations_version);
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION protected_synthetic_participant_lifecycle(text,uuid,uuid,text,text,bigint) FROM PUBLIC;
