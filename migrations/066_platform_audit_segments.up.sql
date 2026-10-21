-- No legacy event, checkpoint or chain-head row is rewritten or resigned.
CREATE TABLE platform_audit_segments (
  id uuid PRIMARY KEY,
  environment text NOT NULL UNIQUE CHECK (environment = 'int'),
  deployment_epoch uuid NOT NULL,
  legacy_event_count bigint NOT NULL CHECK (legacy_event_count >= 0),
  legacy_terminal_event_hash char(64),
  inventory_digest char(64) NOT NULL CHECK (inventory_digest ~ '^[0-9a-f]{64}$'),
  approval_reference text NOT NULL CHECK (approval_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'),
  legacy_verification text NOT NULL DEFAULT 'unavailable' CHECK (legacy_verification = 'unavailable'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((legacy_event_count = 0 AND legacy_terminal_event_hash IS NULL)
    OR (legacy_event_count > 0 AND legacy_terminal_event_hash IS NOT NULL AND legacy_terminal_event_hash ~ '^[0-9a-f]{64}$'))
);
ALTER TABLE platform_audit_events ADD COLUMN segment_id uuid REFERENCES platform_audit_segments(id) ON DELETE RESTRICT;
ALTER TABLE platform_audit_events ADD COLUMN segment_sequence bigint;
ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_integrity_version_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_integrity_version_valid CHECK (
  (integrity_version = 1 AND segment_id IS NULL AND segment_sequence IS NULL)
  OR (integrity_version = 2 AND segment_id IS NOT NULL AND segment_sequence IS NOT NULL AND segment_sequence > 0));
CREATE UNIQUE INDEX platform_audit_segment_sequence_unique ON platform_audit_events(segment_id,segment_sequence);
CREATE TABLE platform_audit_segment_heads (
  segment_id uuid PRIMARY KEY REFERENCES platform_audit_segments(id) ON DELETE RESTRICT,
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  terminal_event_hash char(64),
  terminal_checkpoint_hash char(64),
  CHECK ((event_count = 0 AND terminal_event_hash IS NULL AND terminal_checkpoint_hash IS NULL)
    OR (event_count > 0 AND terminal_event_hash IS NOT NULL AND terminal_event_hash ~ '^[0-9a-f]{64}$')),
  CHECK (terminal_checkpoint_hash IS NULL OR terminal_checkpoint_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE platform_audit_segment_checkpoints (
  segment_id uuid NOT NULL REFERENCES platform_audit_segments(id) ON DELETE RESTRICT,
  event_count bigint NOT NULL CHECK (event_count > 0 AND event_count % 32 = 0),
  terminal_sequence bigint NOT NULL,
  terminal_event_hash char(64) NOT NULL,
  previous_checkpoint_hash char(64),
  checkpoint_hash char(64) NOT NULL UNIQUE CHECK (checkpoint_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  integrity_version smallint NOT NULL DEFAULT 2 CHECK (integrity_version = 2),
  PRIMARY KEY (segment_id,event_count),
  FOREIGN KEY (previous_checkpoint_hash) REFERENCES platform_audit_segment_checkpoints(checkpoint_hash) ON DELETE RESTRICT
);
CREATE TRIGGER platform_audit_segments_append_only BEFORE UPDATE OR DELETE ON platform_audit_segments
  FOR EACH ROW EXECUTE FUNCTION reject_platform_audit_mutation();
CREATE TRIGGER platform_audit_segment_checkpoints_append_only BEFORE UPDATE OR DELETE ON platform_audit_segment_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_platform_audit_mutation();

CREATE FUNCTION platform_legacy_audit_inventory() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'eventCount',(SELECT count(*) FROM public.platform_audit_events WHERE integrity_version=1),
    'terminalEventHash',(SELECT terminal_event_hash FROM public.platform_audit_chain_state WHERE singleton),
    'digest',encode(sha256(convert_to(jsonb_build_object(
      'events',(SELECT coalesce(jsonb_agg(to_jsonb(e)-'segment_id'-'segment_sequence' ORDER BY sequence),'[]'::jsonb)
        FROM public.platform_audit_events e WHERE integrity_version=1),
      'checkpoints',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY event_count),'[]'::jsonb) FROM public.platform_audit_checkpoints c),
      'head',(SELECT to_jsonb(h) FROM public.platform_audit_chain_state h WHERE singleton)
    )::text,'UTF8')),'hex'))
$$;
REVOKE ALL ON FUNCTION platform_legacy_audit_inventory() FROM PUBLIC;

CREATE FUNCTION guard_platform_audit_segment_creation() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE owner_role text; inventory jsonb; old_head record;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass;
  IF current_user<>owner_role OR session_user<>owner_role OR NOT pg_try_advisory_xact_lock(740193,2) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_OWNER_REQUIRED' USING ERRCODE='42501';
  END IF;
  LOCK TABLE public.platform_audit_segments IN ACCESS EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.platform_audit_events IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.platform_operators IN SHARE MODE NOWAIT;
  IF (SELECT count(*) FROM public.platform_audit_events)>3200 THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_INVENTORY_LIMIT' USING ERRCODE='54000';
  END IF;
  SELECT * INTO old_head FROM public.platform_audit_chain_state WHERE singleton FOR UPDATE NOWAIT;
  inventory:=public.platform_legacy_audit_inventory();
  IF EXISTS(SELECT 1 FROM public.platform_audit_segments)
    OR NOT EXISTS(SELECT 1 FROM public.protected_runtime_deployments WHERE environment='int' AND security_epoch=NEW.deployment_epoch)
    OR EXISTS(SELECT 1 FROM public.platform_operators WHERE provider<>'demo_platform')
    OR EXISTS(SELECT 1 FROM public.platform_audit_events WHERE target_type='platform_operator_bootstrap')
    OR EXISTS(SELECT 1 FROM public.platform_passkey_credentials)
    OR EXISTS(SELECT 1 FROM public.platform_passkey_enrollment_grants)
    OR EXISTS(SELECT 1 FROM public.tenant_runtime_registry WHERE mode='real')
    OR EXISTS(SELECT 1 FROM public.platform_audit_events e JOIN public.platform_operators o ON o.id=e.operator_id WHERE o.provider<>'demo_platform')
    OR NEW.legacy_event_count IS DISTINCT FROM (inventory->>'eventCount')::bigint
    OR NEW.legacy_event_count IS DISTINCT FROM old_head.event_count
    OR NEW.legacy_event_count IS DISTINCT FROM (SELECT coalesce(max(sequence),0) FROM public.platform_audit_events)
    OR NEW.legacy_terminal_event_hash IS DISTINCT FROM old_head.terminal_event_hash
    OR NEW.inventory_digest IS DISTINCT FROM inventory->>'digest'
    OR EXISTS(SELECT 1 FROM public.platform_audit_events e WHERE e.previous_hash IS DISTINCT FROM
      (SELECT p.event_hash FROM public.platform_audit_events p WHERE p.sequence=e.sequence-1)) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_CREATION_REFUSED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_segment_creation() FROM PUBLIC;
CREATE TRIGGER platform_audit_segment_creation BEFORE INSERT ON platform_audit_segments
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_segment_creation();

CREATE FUNCTION guard_platform_audit_segment_event() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE segment record; head record; owner_role text;
BEGIN
  LOCK TABLE public.platform_audit_segments IN ACCESS SHARE MODE;
  SELECT * INTO segment FROM public.platform_audit_segments LIMIT 1;
  IF NOT FOUND THEN
    IF NEW.integrity_version<>1 THEN RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_REQUIRED' USING ERRCODE='42501'; END IF;
    IF NEW.target_type='platform_operator_bootstrap' AND EXISTS(SELECT 1 FROM public.platform_audit_events) THEN
      RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_REQUIRED' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO head FROM public.platform_audit_segment_heads WHERE segment_id=segment.id FOR UPDATE;
  IF NOT FOUND OR NEW.integrity_version<>2 OR NEW.segment_id IS DISTINCT FROM segment.id
    OR NEW.segment_sequence IS DISTINCT FROM head.event_count+1
    OR NEW.sequence IS DISTINCT FROM segment.legacy_event_count+NEW.segment_sequence
    OR NEW.previous_hash IS DISTINCT FROM head.terminal_event_hash
    OR NOT EXISTS(SELECT 1 FROM public.protected_runtime_deployments
      WHERE environment=segment.environment AND security_epoch=segment.deployment_epoch) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_EVENT_REFUSED' USING ERRCODE='42501';
  END IF;
  IF NEW.segment_sequence=1 OR NEW.target_type='platform_audit_segment' THEN
    SELECT pg_get_userbyid(relowner) INTO owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass;
    IF NEW.segment_sequence<>1 OR current_user<>owner_role OR session_user<>owner_role
      OR NEW.target_type<>'platform_audit_segment' OR NEW.target_id<>segment.id::text
      OR NEW.operator_id IS NOT NULL OR NEW.assurance_level<>'offline_owner'
      OR NEW.action<>'platform.operator.changed' OR NEW.outcome<>'success' OR NEW.retention_class<>'recovery'
      OR NEW.target_tenant_id IS NOT NULL
      OR NEW.metadata->>'operation' IS DISTINCT FROM 'audit_segment_genesis'
      OR NEW.metadata->>'environment' IS DISTINCT FROM segment.environment
      OR NEW.metadata->>'deploymentEpoch' IS DISTINCT FROM segment.deployment_epoch::text
      OR NEW.metadata->>'inventoryDigest' IS DISTINCT FROM segment.inventory_digest
      OR NEW.metadata->>'approvalReference' IS DISTINCT FROM segment.approval_reference
      OR NEW.metadata->>'legacyVerification' IS DISTINCT FROM 'unavailable' THEN
      RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_GENESIS_REFUSED' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_segment_event() FROM PUBLIC;
CREATE TRIGGER platform_audit_segment_event BEFORE INSERT ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_segment_event();

CREATE FUNCTION guard_platform_audit_frozen_head() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  LOCK TABLE public.platform_audit_segments IN ACCESS SHARE MODE;
  IF EXISTS(SELECT 1 FROM public.platform_audit_segments) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_LEGACY_FROZEN' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_frozen_head() FROM PUBLIC;
CREATE TRIGGER platform_audit_frozen_head BEFORE INSERT OR UPDATE OR DELETE ON platform_audit_chain_state
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_frozen_checkpoint BEFORE INSERT ON platform_audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_truncate BEFORE TRUNCATE ON platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_checkpoint_truncate BEFORE TRUNCATE ON platform_audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_legacy_head_truncate BEFORE TRUNCATE ON platform_audit_chain_state
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_metadata_truncate BEFORE TRUNCATE ON platform_audit_segments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_head_truncate BEFORE TRUNCATE ON platform_audit_segment_heads
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();
CREATE TRIGGER platform_audit_segment_new_checkpoint_truncate BEFORE TRUNCATE ON platform_audit_segment_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION guard_platform_audit_frozen_head();

CREATE FUNCTION guard_platform_audit_segment_checkpoint() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE head record;
BEGIN
  SELECT * INTO head FROM public.platform_audit_segment_heads WHERE segment_id=NEW.segment_id FOR UPDATE;
  IF NOT FOUND OR NEW.event_count<>head.event_count+1
    OR NEW.previous_checkpoint_hash IS DISTINCT FROM head.terminal_checkpoint_hash
    OR NOT EXISTS(SELECT 1 FROM public.platform_audit_events e WHERE e.segment_id=NEW.segment_id
      AND e.segment_sequence=NEW.event_count AND e.sequence=NEW.terminal_sequence AND e.event_hash=NEW.terminal_event_hash) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_CHECKPOINT_REFUSED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_segment_checkpoint() FROM PUBLIC;
CREATE TRIGGER platform_audit_segment_checkpoint BEFORE INSERT ON platform_audit_segment_checkpoints
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_segment_checkpoint();

CREATE FUNCTION guard_platform_audit_segment_head() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
DECLARE owner_role text; item record;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT pg_get_userbyid(relowner) INTO owner_role FROM pg_class WHERE oid='public.platform_operators'::regclass;
    IF current_user=owner_role AND session_user=owner_role AND NEW.event_count=0
      AND NEW.terminal_event_hash IS NULL AND NEW.terminal_checkpoint_hash IS NULL THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' THEN
    SELECT * INTO item FROM public.platform_audit_events WHERE segment_id=OLD.segment_id AND segment_sequence=OLD.event_count+1;
    IF FOUND AND NEW.segment_id=OLD.segment_id AND NEW.event_count=OLD.event_count+1
      AND NEW.terminal_event_hash=item.event_hash AND (NEW.event_count%32<>0
        AND NEW.terminal_checkpoint_hash IS NOT DISTINCT FROM OLD.terminal_checkpoint_hash
        OR NEW.event_count%32=0 AND EXISTS(SELECT 1 FROM public.platform_audit_segment_checkpoints
          WHERE segment_id=NEW.segment_id AND event_count=NEW.event_count AND checkpoint_hash=NEW.terminal_checkpoint_hash)) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_HEAD_REFUSED' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_segment_head() FROM PUBLIC;
CREATE TRIGGER platform_audit_segment_head BEFORE INSERT OR UPDATE OR DELETE ON platform_audit_segment_heads
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_segment_head();

CREATE FUNCTION require_platform_audit_segment_genesis() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.platform_audit_events
    WHERE segment_id=NEW.id AND segment_sequence=1 AND target_type='platform_audit_segment')
    OR NOT EXISTS(SELECT 1 FROM public.platform_audit_segment_heads WHERE segment_id=NEW.id AND event_count>=1) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_SEGMENT_GENESIS_REQUIRED' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION require_platform_audit_segment_genesis() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER platform_audit_segment_genesis AFTER INSERT ON platform_audit_segments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_platform_audit_segment_genesis();

CREATE FUNCTION guard_platform_audit_handoff_segment() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.approval_audit_sequence IS NOT NULL AND EXISTS(SELECT 1 FROM public.platform_audit_segments)
    AND NOT EXISTS(SELECT 1 FROM public.platform_audit_events e JOIN public.platform_audit_segments s ON s.id=e.segment_id
      WHERE e.sequence=NEW.approval_audit_sequence AND e.integrity_version=2 AND s.environment=NEW.environment
        AND EXISTS(SELECT 1 FROM public.protected_runtime_deployments d
          WHERE d.environment=s.environment AND d.security_epoch=s.deployment_epoch)) THEN
    RAISE EXCEPTION 'PLATFORM_AUDIT_HANDOFF_SEGMENT_REFUSED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_platform_audit_handoff_segment() FROM PUBLIC;
CREATE TRIGGER platform_audit_handoff_segment BEFORE INSERT OR UPDATE ON synthetic_customer_handoffs
  FOR EACH ROW EXECUTE FUNCTION guard_platform_audit_handoff_segment();

ALTER TABLE platform_audit_events DROP CONSTRAINT platform_audit_actor_snapshot_valid;
ALTER TABLE platform_audit_events ADD CONSTRAINT platform_audit_actor_snapshot_valid CHECK (
  (operator_id IS NULL AND cardinality(roles)=0 AND cardinality(permissions)=0
    AND ((action='platform.authentication.failed' AND assurance_level='unverified')
      OR (action='platform.operator.changed' AND assurance_level='offline_owner' AND target_tenant_id IS NULL
        AND target_type IN ('platform_passkey_grant','platform_operator_bootstrap','platform_audit_segment')
        AND retention_class='recovery' AND outcome='success')))
  OR (operator_id IS NOT NULL AND platform_roles_are_canonical(roles)
    AND permissions=platform_permissions_for_roles(roles) AND assurance_level IN ('mfa','step_up','break_glass')));
