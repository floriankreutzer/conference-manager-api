LOCK TABLE requests, request_revisions, booking_change_requests IN ACCESS EXCLUSIVE MODE;
CREATE TABLE request_attribution_migration_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  post_cutover_evidence BOOLEAN NOT NULL DEFAULT FALSE
);
INSERT INTO request_attribution_migration_state (singleton) VALUES (TRUE);

CREATE FUNCTION request_attribution_name_valid(value TEXT) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(
    char_length(value) BETWEEN 1 AND 160
    AND value = normalize(value, NFC)
    AND value = btrim(value, U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000')
    AND NOT EXISTS (
      SELECT 1
      FROM generate_series(1, char_length(value)) AS character_offset
      CROSS JOIN LATERAL (
        SELECT ascii(substr(value, character_offset, 1)) AS codepoint
      ) AS character
      WHERE codepoint BETWEEN 0 AND 31
        OR codepoint BETWEEN 127 AND 159
        OR codepoint = 173
        OR codepoint BETWEEN 1536 AND 1541
        OR codepoint = 1564
        OR codepoint = 1757
        OR codepoint = 1807
        OR codepoint BETWEEN 2192 AND 2193
        OR codepoint = 2274
        OR codepoint = 6158
        OR codepoint BETWEEN 8203 AND 8207
        OR codepoint BETWEEN 8232 AND 8238
        OR codepoint BETWEEN 8288 AND 8292
        OR codepoint BETWEEN 8294 AND 8303
        OR codepoint = 65279
        OR codepoint BETWEEN 65529 AND 65531
        OR codepoint = 69821
        OR codepoint = 69837
        OR codepoint BETWEEN 78896 AND 78911
        OR codepoint BETWEEN 113824 AND 113827
        OR codepoint BETWEEN 119155 AND 119162
        OR codepoint = 917505
        OR codepoint BETWEEN 917536 AND 917631
    ),
    FALSE
  );
$$;
CREATE FUNCTION request_actor_display_name(tenant UUID, actor UUID) RETURNS TEXT
LANGUAGE SQL STABLE AS $$
  SELECT normalize(
    btrim(display_name, U&'\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000'),
    NFC
  )
  FROM users WHERE tenant_id = tenant AND id = actor;
$$;
CREATE FUNCTION mark_request_attribution_used() RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE public.request_attribution_migration_state SET post_cutover_evidence = TRUE
    WHERE singleton AND NOT post_cutover_evidence;
$$;

ALTER TABLE requests ADD COLUMN requester_display_name VARCHAR(160);
ALTER TABLE request_revisions
  ADD COLUMN actor_display_name VARCHAR(160), ADD COLUMN actor_role_at_action VARCHAR(32);
ALTER TABLE booking_change_requests
  ADD COLUMN initiator_display_name VARCHAR(160), ADD COLUMN initiator_role_at_action VARCHAR(32),
  ADD COLUMN decider_display_name VARCHAR(160), ADD COLUMN decider_role_at_action VARCHAR(32);

UPDATE requests request SET requester_display_name = request_actor_display_name(
  request.tenant_id, request.requester_user_id);
-- The migration may capture the stored name, but cannot infer historical roles.
ALTER TABLE request_revisions DISABLE TRIGGER request_revisions_append_only;
UPDATE request_revisions revision SET actor_display_name = request_actor_display_name(
  revision.tenant_id, revision.actor_user_id) WHERE revision.actor_user_id IS NOT NULL;
ALTER TABLE request_revisions ENABLE TRIGGER request_revisions_append_only;
UPDATE booking_change_requests change SET
  initiator_display_name = request_actor_display_name(change.tenant_id, change.initiator_user_id),
  decider_display_name = request_actor_display_name(change.tenant_id, change.decided_by_user_id);

-- PostgreSQL 18 refuses to ALTER populated tables while deferred FK checks from
-- this backfill remain queued. Evaluate them now, before adding the final
-- constraints. A failed check aborts this migration's transaction atomically.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE requests ALTER COLUMN requester_display_name SET NOT NULL,
  ADD CONSTRAINT requests_requester_display_valid CHECK (request_attribution_name_valid(requester_display_name));
ALTER TABLE request_revisions ADD CONSTRAINT request_revisions_actor_display_valid CHECK (
  (actor_user_id IS NULL AND actor_display_name IS NULL AND actor_role_at_action IS NULL)
  OR (actor_user_id IS NOT NULL AND actor_display_name IS NULL AND actor_role_at_action IS NULL)
  OR (actor_user_id IS NOT NULL AND request_attribution_name_valid(actor_display_name)
    AND (actor_role_at_action IS NULL OR actor_role_at_action IN ('employee', 'conference_manager')))
);
ALTER TABLE booking_change_requests ALTER COLUMN initiator_display_name SET NOT NULL,
  ADD CONSTRAINT booking_changes_initiator_display_valid CHECK (
    request_attribution_name_valid(initiator_display_name)
    AND (initiator_role_at_action IS NULL OR initiator_role_at_action IN ('employee', 'conference_manager'))
  ),
  ADD CONSTRAINT booking_changes_decider_display_valid CHECK (
    (decided_by_user_id IS NULL AND decider_display_name IS NULL AND decider_role_at_action IS NULL)
    OR (decided_by_user_id IS NOT NULL AND request_attribution_name_valid(decider_display_name)
      AND (decider_role_at_action IS NULL OR decider_role_at_action IN ('employee', 'conference_manager')))
  );

CREATE FUNCTION preserve_requester_attribution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.requester_display_name := request_actor_display_name(NEW.tenant_id, NEW.requester_user_id);
    PERFORM mark_request_attribution_used();
  ELSIF NEW.requester_display_name IS DISTINCT FROM OLD.requester_display_name
    OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'REQUEST_ATTRIBUTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER requests_attribution_snapshot BEFORE INSERT OR UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION preserve_requester_attribution();

CREATE FUNCTION capture_request_revision_attribution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_user_id IS NOT NULL THEN
    IF NEW.actor_role_at_action IS NULL THEN RAISE EXCEPTION 'REQUEST_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514'; END IF;
    NEW.actor_display_name := request_actor_display_name(NEW.tenant_id, NEW.actor_user_id);
    PERFORM mark_request_attribution_used();
  ELSE
    IF NEW.operation <> 'migrated_legacy' THEN
      RAISE EXCEPTION 'REQUEST_ACTOR_REQUIRED' USING ERRCODE = '23514';
    END IF;
    NEW.actor_display_name := NULL;
    NEW.actor_role_at_action := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER request_revisions_attribution_snapshot BEFORE INSERT ON request_revisions
  FOR EACH ROW EXECUTE FUNCTION capture_request_revision_attribution();

CREATE FUNCTION preserve_booking_change_attribution() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.initiator_role_at_action IS NULL THEN RAISE EXCEPTION 'BOOKING_CHANGE_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514'; END IF;
    NEW.initiator_display_name := request_actor_display_name(NEW.tenant_id, NEW.initiator_user_id);
    PERFORM mark_request_attribution_used();
  ELSIF NEW.initiator_display_name IS DISTINCT FROM OLD.initiator_display_name
    OR NEW.initiator_role_at_action IS DISTINCT FROM OLD.initiator_role_at_action
    OR NEW.initiator_user_id IS DISTINCT FROM OLD.initiator_user_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('applied', 'rejected', 'superseded')
    AND NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  IF NEW.decided_by_user_id IS NULL THEN
    NEW.decider_display_name := NULL;
    NEW.decider_role_at_action := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id THEN
    IF NEW.decider_role_at_action IS NULL THEN RAISE EXCEPTION 'BOOKING_CHANGE_ACTOR_ROLE_REQUIRED' USING ERRCODE = '23514'; END IF;
    NEW.decider_display_name := request_actor_display_name(NEW.tenant_id, NEW.decided_by_user_id);
    PERFORM mark_request_attribution_used();
  ELSIF NEW.decider_display_name IS DISTINCT FROM OLD.decider_display_name
    OR NEW.decider_role_at_action IS DISTINCT FROM OLD.decider_role_at_action THEN
    RAISE EXCEPTION 'BOOKING_CHANGE_ATTRIBUTION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER booking_changes_attribution_snapshot BEFORE INSERT OR UPDATE ON booking_change_requests
  FOR EACH ROW EXECUTE FUNCTION preserve_booking_change_attribution();
