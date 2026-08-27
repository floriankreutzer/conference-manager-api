LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_organization_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rooms IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_catalogue_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE requests IN ACCESS EXCLUSIVE MODE;
LOCK TABLE request_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE booking_change_requests IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_room_prices IN ACCESS EXCLUSIVE MODE;
LOCK TABLE request_v2_migration_state IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM requests
    WHERE schema_version = 2 OR request_version <> 1
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM booking_change_requests
    WHERE status = 'superseded'
       OR request_schema_version = 2
       OR base_request_version <> 1
       OR request_draft IS NOT NULL
       OR proposed_request_snapshot IS NOT NULL
       OR move_attempt_number <> 0
       OR recovery_phase <> 'none'
       OR calendar_replacement IS NOT NULL
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM request_revisions
    WHERE operation <> 'migrated_legacy'
       OR request_version <> 1
       OR schema_version <> 1
       OR actor_user_id IS NOT NULL
       OR correlation_id IS NOT NULL
    LIMIT 1
  ) OR EXISTS (
    SELECT request.tenant_id, request.id
    FROM requests request
    LEFT JOIN request_revisions revision
      ON revision.tenant_id = request.tenant_id
     AND revision.request_id = request.id
     AND revision.request_version = 1
     AND revision.schema_version = 1
     AND revision.operation = 'migrated_legacy'
    GROUP BY request.tenant_id, request.id
    HAVING COUNT(revision.request_id) > 1
       OR (
         COUNT(revision.request_id) = 1
         AND MIN(request.current_revision_sequence)
           IS DISTINCT FROM MIN(revision.revision_sequence)
       )
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM tenants tenant
    JOIN request_v2_migration_state state ON state.tenant_id = tenant.id
    WHERE tenant.catalog_revision <> state.previous_catalog_revision + 1
       OR tenant.updated_at <> GREATEST(
         state.previous_tenant_updated_at,
         state.migrated_at
       )
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM tenant_room_prices prices
    LEFT JOIN tenant_organization_settings organization
      ON organization.tenant_id = prices.tenant_id
    LEFT JOIN request_v2_migration_state state
      ON state.tenant_id = prices.tenant_id
    WHERE organization.tenant_id IS NULL
       OR state.tenant_id IS NULL
       OR prices.price_minor <> 0
       OR prices.currency IS DISTINCT FROM organization.default_currency
       OR prices.created_at <> state.migrated_at
       OR prices.updated_at <> state.migrated_at
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM rooms room
    JOIN request_v2_migration_state state
      ON state.tenant_id = room.tenant_id
     AND room.created_at <= state.migrated_at
    LEFT JOIN tenant_room_prices prices
      ON prices.tenant_id = room.tenant_id
     AND prices.room_id = room.id
    WHERE prices.room_id IS NULL
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM tenant_catalogue_revisions revision
    LEFT JOIN request_v2_migration_state state
      ON state.tenant_id = revision.tenant_id
     AND state.previous_catalog_revision + 1 = revision.revision
    WHERE revision.snapshot ? 'roomPrices'
      AND state.tenant_id IS NULL
      AND revision.snapshot -> 'roomPrices' IS DISTINCT FROM '[]'::JSONB
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM request_v2_migration_state state
    LEFT JOIN tenant_catalogue_revisions revision
      ON revision.tenant_id = state.tenant_id
     AND revision.revision = state.previous_catalog_revision + 1
    WHERE revision.tenant_id IS NULL
       OR revision.snapshot -> 'roomPrices' IS DISTINCT FROM COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'roomId', prices.room_id,
             'price', jsonb_build_object(
               'amountMinor', prices.price_minor,
               'currency', prices.currency
             )
           )
           ORDER BY prices.room_id
         )
         FROM tenant_room_prices prices
         WHERE prices.tenant_id = state.tenant_id
       ), '[]'::JSONB)
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'REQUEST_COMPOSITION_V2_ROLLBACK_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP TRIGGER booking_change_proposal_identity_immutable ON booking_change_requests;

DROP FUNCTION prevent_booking_change_proposal_identity_mutation();

ALTER TABLE booking_change_requests
  DROP CONSTRAINT booking_change_superseded_valid,
  DROP CONSTRAINT booking_change_status_valid,
  ADD CONSTRAINT booking_change_status_valid
    CHECK (status IN ('pending', 'applying', 'applied', 'rejected'));

ALTER TABLE booking_change_requests
  DROP CONSTRAINT booking_change_request_composition_valid,
  DROP CONSTRAINT booking_change_calendar_recovery_valid,
  DROP CONSTRAINT booking_change_calendar_replacement_valid,
  DROP CONSTRAINT booking_change_recovery_phase_valid,
  DROP CONSTRAINT booking_change_move_attempt_number_valid,
  DROP CONSTRAINT booking_change_v2_schedule_limit,
  DROP CONSTRAINT booking_change_v2_participant_limit,
  DROP CONSTRAINT booking_change_base_request_version_positive,
  DROP CONSTRAINT booking_change_request_schema_valid,
  DROP CONSTRAINT booking_change_room_fk,
  DROP COLUMN calendar_replacement,
  DROP COLUMN recovery_phase,
  DROP COLUMN move_attempt_number,
  DROP COLUMN proposed_request_snapshot,
  DROP COLUMN request_draft,
  DROP COLUMN base_request_version,
  DROP COLUMN request_schema_version;

DROP TRIGGER request_revisions_current_pointer_integrity ON request_revisions;
DROP TRIGGER requests_current_revision_integrity ON requests;
DROP FUNCTION enforce_request_revision_pointer_integrity();

DROP TRIGGER request_revisions_append_only ON request_revisions;

ALTER TABLE requests
  DROP CONSTRAINT requests_current_revision_fk;

DROP INDEX requests_tenant_revision_watermark_idx;

DROP TABLE request_revisions;

DROP INDEX requests_tenant_report_range_idx;

ALTER TABLE requests
  DROP CONSTRAINT requests_v2_schedule_limit,
  DROP CONSTRAINT requests_v2_room_required,
  DROP CONSTRAINT requests_v2_participant_limit,
  DROP CONSTRAINT requests_snapshot_schema_valid,
  DROP CONSTRAINT requests_current_revision_sequence_positive,
  DROP CONSTRAINT requests_request_version_positive,
  DROP CONSTRAINT requests_schema_version_valid,
  DROP COLUMN current_revision_sequence,
  DROP COLUMN request_snapshot,
  DROP COLUMN request_version,
  DROP COLUMN schema_version;

UPDATE tenants tenant
SET catalog_revision = state.previous_catalog_revision,
    updated_at = state.previous_tenant_updated_at
FROM request_v2_migration_state state
WHERE tenant.id = state.tenant_id;

ALTER TABLE tenant_catalogue_revisions
  DISABLE TRIGGER tenant_catalogue_revisions_append_only;

UPDATE tenant_catalogue_revisions revision
SET snapshot = revision.snapshot - 'roomPrices'
WHERE revision.snapshot ? 'roomPrices'
  AND NOT EXISTS (
    SELECT 1
    FROM request_v2_migration_state state
    WHERE state.tenant_id = revision.tenant_id
  );

DELETE FROM tenant_catalogue_revisions revision
USING request_v2_migration_state state
WHERE revision.tenant_id = state.tenant_id
  AND revision.revision = state.previous_catalog_revision + 1;

ALTER TABLE tenant_catalogue_revisions
  ENABLE TRIGGER tenant_catalogue_revisions_append_only;

CREATE OR REPLACE FUNCTION initialize_tenant_catalogue_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO tenant_catalogue_revisions (
    tenant_id,
    revision,
    snapshot,
    effective_at,
    actor_user_id,
    correlation_id
  )
  VALUES (
    NEW.id,
    NEW.catalog_revision,
    jsonb_build_object(
      'services', '[]'::JSONB,
      'equipment', '[]'::JSONB,
      'cateringPackages', '[]'::JSONB,
      'cateringItems', '[]'::JSONB
    ),
    NEW.updated_at,
    NULL,
    NULL
  );

  RETURN NEW;
END;
$$;

DROP TABLE tenant_room_prices;
DROP TABLE request_v2_migration_state;
