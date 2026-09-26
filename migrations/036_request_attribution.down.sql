LOCK TABLE requests, request_revisions, booking_change_requests IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM request_attribution_migration_state WHERE post_cutover_evidence) THEN
    RAISE EXCEPTION 'REQUEST_ATTRIBUTION_ROLLBACK_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END $$;
DROP TRIGGER booking_changes_attribution_snapshot ON booking_change_requests;
DROP TRIGGER request_revisions_attribution_snapshot ON request_revisions;
DROP TRIGGER requests_attribution_snapshot ON requests;
DROP FUNCTION preserve_booking_change_attribution();
DROP FUNCTION capture_request_revision_attribution();
DROP FUNCTION preserve_requester_attribution();
ALTER TABLE booking_change_requests
  DROP COLUMN initiator_display_name, DROP COLUMN initiator_role_at_action,
  DROP COLUMN decider_display_name, DROP COLUMN decider_role_at_action;
ALTER TABLE request_revisions DROP COLUMN actor_display_name, DROP COLUMN actor_role_at_action;
ALTER TABLE requests DROP COLUMN requester_display_name;
DROP FUNCTION request_actor_display_name(UUID, UUID);
DROP FUNCTION request_attribution_name_valid(TEXT);
DROP FUNCTION mark_request_attribution_used();
DROP TABLE request_attribution_migration_state;
