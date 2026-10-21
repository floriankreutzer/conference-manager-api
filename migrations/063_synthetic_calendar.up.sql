-- Private durable provider state. No Tenant, integration or calendar is activated.
-- Each room has a private versioned mutex. Event writes advance this tuple,
-- so a concurrent repeatable-read snapshot fails serialization rather than
-- missing another committed reservation. No extension or hashed room identity.
CREATE TABLE synthetic_calendar_resources (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int')),
  security_epoch uuid NOT NULL,
  tenant_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  room_id varchar(128) NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,room_id),
  FOREIGN KEY(environment,tenant_id) REFERENCES tenant_runtime_registry(environment,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,generation_id) REFERENCES synthetic_tenant_generations(environment,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,integration_id) REFERENCES integrations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,room_id) REFERENCES rooms(tenant_id,id) ON DELETE RESTRICT
);
REVOKE ALL ON TABLE synthetic_calendar_resources FROM PUBLIC;

CREATE FUNCTION guard_synthetic_calendar_resource() RETURNS trigger
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
REVOKE ALL ON FUNCTION guard_synthetic_calendar_resource() FROM PUBLIC;
CREATE TRIGGER synthetic_calendar_resource_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_calendar_resources
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_calendar_resource();

CREATE TABLE synthetic_calendar_events (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int')),
  security_epoch uuid NOT NULL,
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  generation_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  room_id varchar(128) NOT NULL,
  request_id varchar(128) NOT NULL,
  idempotency_key char(64) NOT NULL CHECK(idempotency_key ~ '^[0-9a-f]{64}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('active','cancelled')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,integration_id,idempotency_key),
  FOREIGN KEY(environment,tenant_id) REFERENCES tenant_runtime_registry(environment,tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,generation_id) REFERENCES synthetic_tenant_generations(environment,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,integration_id) REFERENCES integrations(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,room_id) REFERENCES rooms(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,room_id) REFERENCES synthetic_calendar_resources(tenant_id,room_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,request_id) REFERENCES requests(tenant_id,id) ON DELETE RESTRICT,
  CHECK(isfinite(starts_at) AND isfinite(ends_at) AND ends_at>starts_at AND ends_at-starts_at<=interval '366 days'),
  CHECK(updated_at>=created_at)
);
CREATE INDEX synthetic_calendar_room_period_idx ON synthetic_calendar_events(tenant_id,room_id,starts_at,ends_at)
  WHERE state='active';
REVOKE ALL ON TABLE synthetic_calendar_events FROM PUBLIC;

CREATE FUNCTION guard_synthetic_calendar_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID<>'public.synthetic_calendar_events'::regclass OR TG_LEVEL<>'ROW' OR TG_WHEN<>'BEFORE'
    OR TG_NARGS<>0 OR pg_trigger_depth()<>1 OR TG_OP NOT IN ('INSERT','UPDATE')
    OR (session_user::text<>('cm_protected_'||NEW.environment||'_customer') AND session_user::text<>current_user::text) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'active' OR NEW.revision<>1 THEN
      RAISE EXCEPTION 'SYNTHETIC_CALENDAR_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.environment,NEW.security_epoch,NEW.tenant_id,NEW.id,NEW.generation_id,NEW.integration_id,
        NEW.room_id,NEW.request_id,NEW.idempotency_key,NEW.created_at)
      IS DISTINCT FROM (OLD.environment,OLD.security_epoch,OLD.tenant_id,OLD.id,OLD.generation_id,OLD.integration_id,
        OLD.room_id,OLD.request_id,OLD.idempotency_key,OLD.created_at)
      OR OLD.state='cancelled' OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
      OR (NEW.state='cancelled' AND (NEW.starts_at,NEW.ends_at) IS DISTINCT FROM (OLD.starts_at,OLD.ends_at)) THEN
      RAISE EXCEPTION 'SYNTHETIC_CALENDAR_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.environment NOT IN ('dev','int') OR NOT pg_try_advisory_xact_lock_shared(740193,
    CASE NEW.environment WHEN 'dev' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  -- Definer ownership permits locks without granting Customer Platform UPDATE.
  -- The complete exact current custody predicate is evaluated after row locks.
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
      AND generation.state='active' AND actor.provider='microsoft_entra_platform' AND actor.status='active'
      AND tenant.status='active' AND integration.provider='synthetic_calendar' AND integration.status='active'
      AND integration.provider_reference='synthetic:' || generation.id::text
    FOR SHARE OF generation,deployment,actor,tenant,integration;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  UPDATE public.synthetic_calendar_resources SET revision=revision+1
    WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND environment=NEW.environment
      AND security_epoch=NEW.security_epoch AND generation_id=NEW.generation_id AND integration_id=NEW.integration_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='23514'; END IF;
  IF NEW.state='active' AND EXISTS(SELECT 1 FROM public.synthetic_calendar_events event
    WHERE event.tenant_id=NEW.tenant_id AND event.room_id=NEW.room_id AND event.id<>NEW.id AND event.state='active'
      AND event.starts_at<NEW.ends_at AND event.ends_at>NEW.starts_at) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_CONFLICT' USING ERRCODE='23P01'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_calendar_event() FROM PUBLIC;
CREATE TRIGGER synthetic_calendar_event_guard BEFORE INSERT OR UPDATE OR DELETE ON synthetic_calendar_events
  FOR EACH ROW EXECUTE FUNCTION guard_synthetic_calendar_event();

CREATE FUNCTION guard_synthetic_calendar_truncate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_RELID NOT IN ('public.synthetic_calendar_events'::regclass,'public.synthetic_calendar_resources'::regclass)
    OR TG_LEVEL<>'STATEMENT' OR TG_WHEN<>'BEFORE'
    OR TG_OP<>'TRUNCATE' OR TG_NARGS<>0 OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.synthetic_calendar_events LIMIT 1)
    OR EXISTS(SELECT 1 FROM public.synthetic_calendar_resources LIMIT 1) THEN
    RAISE EXCEPTION 'SYNTHETIC_CALENDAR_HISTORY_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION guard_synthetic_calendar_truncate() FROM PUBLIC;
CREATE TRIGGER synthetic_calendar_truncate_guard BEFORE TRUNCATE ON synthetic_calendar_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_calendar_truncate();
CREATE TRIGGER synthetic_calendar_resource_truncate_guard BEFORE TRUNCATE ON synthetic_calendar_resources
  FOR EACH STATEMENT EXECUTE FUNCTION guard_synthetic_calendar_truncate();
