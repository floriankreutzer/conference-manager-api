-- Provider source intake is separate from Manager publication and availability.
-- No existing catalogue or connection is backfilled or activated.
CREATE FUNCTION catering_provider_catalogue_text_valid(value jsonb,maximum integer,nullable boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE content text;
BEGIN
  IF nullable AND value='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  content:=value#>>'{}';
  RETURN length(content) BETWEEN 1 AND maximum AND content IS NFC NORMALIZED
    AND content=btrim(content,' '||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)
      ||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)
      ||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
    AND content !~ '[<>[:cntrl:]]'
    AND translate(content,chr(8234)||chr(8235)||chr(8236)||chr(8237)||chr(8238)
      ||chr(8294)||chr(8295)||chr(8296)||chr(8297),'')=content;
END $$;
CREATE FUNCTION catering_provider_catalogue_money_valid(value jsonb,aggregate_value boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE amount text;
BEGIN
  IF value='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF ARRAY(SELECT jsonb_object_keys(value) ORDER BY 1)<>ARRAY['amountMinor','currency']
    OR jsonb_typeof(value->'amountMinor') IS DISTINCT FROM 'number'
    OR jsonb_typeof(value->'currency') IS DISTINCT FROM 'string'
    OR value->>'currency' NOT IN ('CHF','EUR','GBP','USD') THEN RETURN false; END IF;
  amount:=value->>'amountMinor';
  IF amount !~ '^(0|[1-9][0-9]{0,15})$' THEN RETURN false; END IF;
  RETURN amount::bigint <= CASE WHEN aggregate_value THEN 9007199254740990 ELSE 1000000000 END;
END $$;
CREATE FUNCTION catering_provider_catalogue_product_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF ARRAY(SELECT jsonb_object_keys(value) ORDER BY 1)<>ARRAY['description','id','name','providerPrice']
    OR jsonb_typeof(value->'id') IS DISTINCT FROM 'string'
    OR value->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN RETURN false; END IF;
  RETURN public.catering_provider_catalogue_text_valid(value->'name',160,false)
    AND public.catering_provider_catalogue_text_valid(value->'description',1000,true)
    AND public.catering_provider_catalogue_money_valid(value->'providerPrice',false);
END $$;
CREATE FUNCTION catering_provider_catalogue_document_valid(document jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE
  entry jsonb;
  bundle jsonb;
  variant jsonb;
  component jsonb;
  duration jsonb;
  duration_key text;
BEGIN
  IF jsonb_typeof(document) IS DISTINCT FROM 'object' OR octet_length(document::text)>1048576 THEN RETURN false; END IF;
  IF ARRAY(SELECT jsonb_object_keys(document) ORDER BY 1)<>ARRAY['items','packages','schemaVersion','sourceVersion','terms']
    OR document->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR NOT public.catering_provider_catalogue_text_valid(document->'sourceVersion',160,true)
    OR jsonb_typeof(document->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(document->'packages') IS DISTINCT FROM 'array'
    OR jsonb_typeof(document->'terms') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF jsonb_array_length(document->'items')>300 OR jsonb_array_length(document->'packages')>100
    OR ARRAY(SELECT jsonb_object_keys(document->'terms') ORDER BY 1)
      <>ARRAY['cancelCutoffMinutes','changeCutoffMinutes','minimumLeadTimeMinutes','minimumOrderValue']
    OR NOT public.catering_provider_catalogue_money_valid(document->'terms'->'minimumOrderValue',true) THEN RETURN false; END IF;
  FOREACH duration_key IN ARRAY ARRAY['cancelCutoffMinutes','changeCutoffMinutes','minimumLeadTimeMinutes'] LOOP
    duration:=document->'terms'->duration_key;
    IF duration<>'null'::jsonb THEN
      IF jsonb_typeof(duration) IS DISTINCT FROM 'number' OR duration::text !~ '^(0|[1-9][0-9]{0,5})$' THEN RETURN false; END IF;
      IF duration::text::integer>525600 THEN RETURN false; END IF;
    END IF;
  END LOOP;
  FOR entry IN SELECT value FROM jsonb_array_elements(document->'items') LOOP
    IF NOT public.catering_provider_catalogue_product_valid(entry) THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(document->'items') item)
    <>jsonb_array_length(document->'items') THEN RETURN false; END IF;
  FOR bundle IN SELECT value FROM jsonb_array_elements(document->'packages') LOOP
    IF jsonb_typeof(bundle) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF ARRAY(SELECT jsonb_object_keys(bundle) ORDER BY 1)
      <>ARRAY['description','id','itemIds','name','providerPrice','variants']
      OR NOT public.catering_provider_catalogue_product_valid(bundle-'itemIds'-'variants')
      OR jsonb_typeof(bundle->'itemIds') IS DISTINCT FROM 'array'
      OR jsonb_typeof(bundle->'variants') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(bundle->'itemIds')>300 OR jsonb_array_length(bundle->'variants')>20 THEN RETURN false; END IF;
    FOR component IN SELECT value FROM jsonb_array_elements(bundle->'itemIds') LOOP
      IF jsonb_typeof(component) IS DISTINCT FROM 'string' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(document->'items') item WHERE item->'id'=component
      ) THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(bundle->'itemIds'))
      <>jsonb_array_length(bundle->'itemIds') THEN RETURN false; END IF;
    FOR variant IN SELECT value FROM jsonb_array_elements(bundle->'variants') LOOP
      IF NOT public.catering_provider_catalogue_product_valid(variant) THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(bundle->'variants') item)
      <>jsonb_array_length(bundle->'variants') THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(document->'packages') item)
    =jsonb_array_length(document->'packages');
END $$;

CREATE TABLE catering_provider_catalogue_revisions (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  configuration_revision bigint NOT NULL CHECK (configuration_revision BETWEEN 1 AND 9007199254740990),
  command_id uuid NOT NULL,
  provider_id varchar(48) NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9_]{1,47}$'),
  reference varchar(160) NOT NULL,
  attest_received_from_supplier boolean NOT NULL CHECK (attest_received_from_supplier=true),
  source jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_by_user_id uuid NOT NULL,
  actor_security_version bigint NOT NULL CHECK (actor_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,integration_id,revision),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,integration_id,configuration_revision)
    REFERENCES catering_integration_configuration_revisions(tenant_id,integration_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,recorded_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE catering_provider_catalogue_heads (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (tenant_id,integration_id),
  FOREIGN KEY (tenant_id,integration_id,revision)
    REFERENCES catering_provider_catalogue_revisions(tenant_id,integration_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION guard_catering_provider_catalogue_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_revision bigint;
BEGIN
  PERFORM 1 FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_TENANT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.recorded_by_user_id
    AND active=true AND security_version=NEW.actor_security_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_ACTOR_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.catering_integration_configurations configuration
    JOIN public.integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
    WHERE configuration.tenant_id=NEW.tenant_id AND configuration.integration_id=NEW.integration_id
      AND configuration.revision=NEW.configuration_revision AND configuration.catalogue_mode='manual'
      AND integration.provider=NEW.provider_id AND integration.status IN ('configured','active')
    FOR SHARE OF configuration,integration;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_SOURCE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  SELECT revision INTO current_revision FROM public.catering_provider_catalogue_heads
    WHERE tenant_id=NEW.tenant_id AND integration_id=NEW.integration_id FOR UPDATE;
  IF NEW.revision<>coalesce(current_revision,0)+1
    OR NEW.attest_received_from_supplier IS DISTINCT FROM true
    OR NOT public.catering_provider_catalogue_document_valid(NEW.source)
    OR NOT public.catering_provider_catalogue_text_valid(to_jsonb(NEW.reference),160,false) THEN
    RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_SOURCE_INVALID' USING ERRCODE='23514';
  END IF;
  NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION guard_catering_provider_catalogue_head()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND (
    (NEW.tenant_id,NEW.integration_id) IS DISTINCT FROM (OLD.tenant_id,OLD.integration_id)
    OR NEW.revision<>OLD.revision+1)) THEN
    RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_REVISION_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION verify_catering_provider_catalogue_source()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catering_provider_catalogue_heads
    WHERE tenant_id=NEW.tenant_id AND integration_id=NEW.integration_id AND revision=NEW.revision)
    OR NOT EXISTS (SELECT 1 FROM public.audit_events WHERE tenant_id=NEW.tenant_id
      AND actor_user_id=NEW.recorded_by_user_id AND correlation_id=NEW.correlation_id
      AND action='catering.catalogue.received' AND target_type='integration' AND target_id=NEW.integration_id::text
      AND outcome='success' AND retention_class='business'
      AND previous_state=jsonb_build_object('revision',NEW.revision-1)
      AND new_state=jsonb_build_object('revision',NEW.revision,'configurationRevision',NEW.configuration_revision)
      AND metadata=jsonb_build_object('operation','catering_provider_catalogue_receive','source','manual',
        'itemCount',jsonb_array_length(NEW.source->'items'),'packageCount',jsonb_array_length(NEW.source->'packages'))) THEN
    RAISE EXCEPTION 'CATERING_PROVIDER_CATALOGUE_COMPLETION_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_provider_catalogue_source_guard BEFORE INSERT ON catering_provider_catalogue_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_catering_provider_catalogue_source();
CREATE TRIGGER catering_provider_catalogue_revision_immutable BEFORE UPDATE OR DELETE ON catering_provider_catalogue_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_provider_catalogue_head_guard BEFORE INSERT OR UPDATE ON catering_provider_catalogue_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_provider_catalogue_head();
CREATE TRIGGER catering_provider_catalogue_head_immutable BEFORE DELETE ON catering_provider_catalogue_heads
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE CONSTRAINT TRIGGER catering_provider_catalogue_source_complete AFTER INSERT ON catering_provider_catalogue_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_provider_catalogue_source();
REVOKE ALL ON TABLE catering_provider_catalogue_revisions,catering_provider_catalogue_heads FROM PUBLIC;
REVOKE ALL ON FUNCTION catering_provider_catalogue_text_valid(jsonb,integer,boolean),
  catering_provider_catalogue_money_valid(jsonb,boolean),catering_provider_catalogue_product_valid(jsonb),
  catering_provider_catalogue_document_valid(jsonb),guard_catering_provider_catalogue_source(),
  guard_catering_provider_catalogue_head(),verify_catering_provider_catalogue_source() FROM PUBLIC;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (action IN (
  'session.issued','session.revoked','session.rotated',
  'authentication.failed','authorization.denied','request.started',
  'request.abandoned','request.created','request.transition',
  'request.transition_failed','request.booking_change','tenant.configuration.changed',
  'tenant.user_permissions.changed','tenant.entitlement.changed','tenant.lifecycle.changed',
  'tenant.onboarding.invited','tenant.identity.claimed','tenant.identity.unbound',
  'tenant.user.provisioned','tenant.user.profile_updated','integration.connected',
  'integration.disconnected','integration.admin_consent.changed','integration.verified',
  'calendar.operation','catering.catalogue.received','catering.order.prepared',
  'catering.order.quoted','catering.order.decided','catering.delivery.queued',
  'catering.delivery.claimed','catering.delivery.attempted','catering.delivery.observed',
  'catering.delivery.deferred','catering.delivery.recovered','catering.order.version_proposed',
  'catering.order.withdrawn','catering.order.unsent_replaced','catering.manual.transmitted',
  'catering.manual.receipt','audit.read'
));
