LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_organization_settings IN ACCESS EXCLUSIVE MODE;
LOCK TABLE rooms IN ACCESS EXCLUSIVE MODE;
LOCK TABLE tenant_catalogue_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE requests IN ACCESS EXCLUSIVE MODE;
LOCK TABLE booking_change_requests IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenants tenant
    LEFT JOIN tenant_organization_settings organization
      ON organization.tenant_id = tenant.id
    LEFT JOIN tenant_catalogue_revisions catalogue
      ON catalogue.tenant_id = tenant.id
     AND catalogue.revision = tenant.catalog_revision
    WHERE organization.tenant_id IS NULL
       OR catalogue.tenant_id IS NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'REQUEST_COMPOSITION_V2_AUTHORITY_INCOMPLETE'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM requests
    WHERE status IN ('Rejected', 'Change Requested')
      AND status_reason IS NULL
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'REQUEST_COMPOSITION_V2_LEGACY_REQUEST_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE TABLE request_v2_migration_state (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  previous_catalog_revision BIGINT NOT NULL,
  previous_tenant_updated_at TIMESTAMPTZ NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT request_v2_previous_catalog_revision_positive
    CHECK (previous_catalog_revision >= 1)
);

INSERT INTO request_v2_migration_state (
  tenant_id,
  previous_catalog_revision,
  previous_tenant_updated_at,
  migrated_at
)
SELECT id, catalog_revision, updated_at, clock_timestamp()
FROM tenants;

CREATE TABLE tenant_room_prices (
  tenant_id UUID NOT NULL,
  room_id VARCHAR(128) NOT NULL,
  price_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, room_id),
  CONSTRAINT tenant_room_prices_room_fk
    FOREIGN KEY (tenant_id, room_id)
    REFERENCES rooms(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tenant_room_prices_amount_valid
    CHECK (price_minor BETWEEN 0 AND 1000000000),
  CONSTRAINT tenant_room_prices_currency_valid
    CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD')),
  CONSTRAINT tenant_room_prices_timestamps_valid
    CHECK (updated_at >= created_at)
);

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
      'cateringItems', '[]'::JSONB,
      'roomPrices', '[]'::JSONB
    ),
    NEW.updated_at,
    NULL,
    NULL
  );

  RETURN NEW;
END;
$$;

INSERT INTO tenant_room_prices (
  tenant_id,
  room_id,
  price_minor,
  currency,
  created_at,
  updated_at
)
SELECT
  r.tenant_id,
  r.id,
  0,
  organization.default_currency,
  state.migrated_at,
  state.migrated_at
FROM rooms r
JOIN tenant_organization_settings organization
  ON organization.tenant_id = r.tenant_id
JOIN request_v2_migration_state state
  ON state.tenant_id = r.tenant_id;

INSERT INTO tenant_catalogue_revisions (
  tenant_id,
  revision,
  snapshot,
  effective_at,
  actor_user_id,
  correlation_id
)
SELECT
  state.tenant_id,
  state.previous_catalog_revision + 1,
  previous.snapshot || jsonb_build_object(
    'roomPrices',
    COALESCE((
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
    ), '[]'::jsonb)
  ),
  state.migrated_at,
  NULL,
  NULL
FROM request_v2_migration_state state
JOIN tenant_catalogue_revisions previous
  ON previous.tenant_id = state.tenant_id
 AND previous.revision = state.previous_catalog_revision;

UPDATE tenants tenant
SET catalog_revision = state.previous_catalog_revision + 1,
    updated_at = GREATEST(tenant.updated_at, state.migrated_at)
FROM request_v2_migration_state state
WHERE tenant.id = state.tenant_id;

ALTER TABLE requests
  ADD COLUMN schema_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN request_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN request_snapshot JSONB,
  ADD COLUMN current_revision_sequence BIGINT,
  ADD CONSTRAINT requests_schema_version_valid
    CHECK (schema_version IN (1, 2)),
  ADD CONSTRAINT requests_request_version_positive
    CHECK (request_version BETWEEN 1 AND 9007199254740990),
  ADD CONSTRAINT requests_current_revision_sequence_positive
    CHECK (
      current_revision_sequence IS NULL
      OR current_revision_sequence BETWEEN 1 AND 9007199254740990
    ),
  ADD CONSTRAINT requests_snapshot_schema_valid
    CHECK (
      (schema_version = 1 AND request_snapshot IS NULL)
      OR COALESCE((
        schema_version = 2
        AND request_snapshot IS NOT NULL
        AND jsonb_typeof(request_snapshot) = 'object'
        AND request_snapshot ?& ARRAY[
          'schemaVersion',
          'requestVersion',
          'capturedAt',
          'configurationRevisions',
          'details',
          'pricing',
          'policy',
          'allocations'
        ]
        AND request_snapshot - ARRAY[
          'schemaVersion',
          'requestVersion',
          'capturedAt',
          'configurationRevisions',
          'details',
          'pricing',
          'policy',
          'allocations'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_snapshot -> 'schemaVersion') = 'number'
        AND jsonb_typeof(request_snapshot -> 'requestVersion') = 'number'
        AND (request_snapshot ->> 'requestVersion') ~ '^[0-9]+$'
        AND jsonb_typeof(request_snapshot -> 'capturedAt') = 'string'
        AND jsonb_typeof(request_snapshot -> 'configurationRevisions') = 'object'
        AND (request_snapshot -> 'configurationRevisions') ?& ARRAY[
          'organization',
          'locations',
          'catalogue',
          'bookingPolicies',
          'costAllocation'
        ]
        AND (request_snapshot -> 'configurationRevisions') - ARRAY[
          'organization',
          'locations',
          'catalogue',
          'bookingPolicies',
          'costAllocation'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_snapshot #> '{configurationRevisions,organization}') = 'number'
        AND jsonb_typeof(request_snapshot #> '{configurationRevisions,locations}') = 'number'
        AND jsonb_typeof(request_snapshot #> '{configurationRevisions,catalogue}') = 'number'
        AND jsonb_typeof(request_snapshot #> '{configurationRevisions,bookingPolicies}') = 'number'
        AND jsonb_typeof(request_snapshot #> '{configurationRevisions,costAllocation}') = 'number'
        AND jsonb_typeof(request_snapshot -> 'details') = 'object'
        AND (request_snapshot -> 'details') ?& ARRAY[
          'title',
          'specialRequirements',
          'dietaryRequirements',
          'serviceIds',
          'catering'
        ]
        AND (request_snapshot -> 'details') - ARRAY[
          'title',
          'specialRequirements',
          'dietaryRequirements',
          'serviceIds',
          'catering'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_snapshot #> '{details,title}') = 'string'
        AND jsonb_typeof(request_snapshot #> '{details,serviceIds}') = 'array'
        AND jsonb_typeof(request_snapshot #> '{details,catering}') = 'object'
        AND (request_snapshot #> '{details,catering}') ?& ARRAY[
          'participantCount',
          'packageSelection',
          'itemQuantities'
        ]
        AND (request_snapshot #> '{details,catering}') - ARRAY[
          'participantCount',
          'packageSelection',
          'itemQuantities'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_snapshot #> '{details,catering,participantCount}') = 'number'
        AND jsonb_typeof(request_snapshot #> '{details,catering,itemQuantities}') = 'array'
        AND jsonb_typeof(request_snapshot -> 'pricing') = 'object'
        AND (request_snapshot -> 'pricing') ?& ARRAY[
          'currency',
          'totalMinor',
          'breakdown',
          'room',
          'services',
          'catering'
        ]
        AND (request_snapshot -> 'pricing') - ARRAY[
          'currency',
          'totalMinor',
          'breakdown',
          'room',
          'services',
          'catering'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_snapshot #> '{pricing,room}') = 'object'
        AND jsonb_typeof(request_snapshot #> '{pricing,room,id}') = 'string'
        AND jsonb_typeof(request_snapshot #> '{pricing,services}') = 'array'
        AND jsonb_typeof(request_snapshot #> '{pricing,catering}') = 'object'
        AND jsonb_typeof(request_snapshot -> 'policy') = 'object'
        AND jsonb_typeof(request_snapshot -> 'allocations') = 'object'
        AND request_snapshot ->> 'schemaVersion' = '2'
        AND (request_snapshot ->> 'requestVersion')::BIGINT = request_version
        AND request_snapshot #>> '{pricing,room,id}' = room_id
        AND (request_snapshot #>> '{details,catering,participantCount}')::INTEGER
          BETWEEN 0 AND internal_participants::BIGINT + external_participants::BIGINT
        AND octet_length(request_snapshot::TEXT) <= 524288
      ), FALSE)
    ),
  ADD CONSTRAINT requests_v2_participant_limit
    CHECK (
      schema_version = 1
      OR internal_participants::BIGINT + external_participants::BIGINT BETWEEN 1 AND 500
    ),
  ADD CONSTRAINT requests_v2_room_required
    CHECK (schema_version = 1 OR room_id IS NOT NULL),
  ADD CONSTRAINT requests_v2_schedule_limit
    CHECK (
      schema_version = 1
      OR ends_at <= starts_at + INTERVAL '24 hours'
    );

CREATE INDEX requests_tenant_report_range_idx
  ON requests (tenant_id, starts_at, id);

CREATE INDEX requests_tenant_revision_watermark_idx
  ON requests (tenant_id, current_revision_sequence, id)
  WHERE current_revision_sequence IS NOT NULL;

CREATE TABLE request_revisions (
  tenant_id UUID NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  request_version BIGINT NOT NULL,
  schema_version SMALLINT NOT NULL,
  operation VARCHAR(32) NOT NULL,
  record JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID,
  correlation_id UUID,
  revision_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (tenant_id, request_id, request_version),
  CONSTRAINT request_revisions_sequence_unique
    UNIQUE (revision_sequence),
  CONSTRAINT request_revisions_request_sequence_unique
    UNIQUE (tenant_id, request_id, revision_sequence),
  CONSTRAINT request_revisions_request_fk
    FOREIGN KEY (tenant_id, request_id)
    REFERENCES requests(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT request_revisions_actor_fk
    FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES users(tenant_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT request_revisions_version_positive
    CHECK (request_version BETWEEN 1 AND 9007199254740990),
  CONSTRAINT request_revisions_schema_valid
    CHECK (schema_version IN (1, 2)),
  CONSTRAINT request_revisions_operation_valid
    CHECK (operation IN (
      'migrated_legacy',
      'created',
      'resubmitted',
      'transitioned',
      'booking_changed'
    )),
  CONSTRAINT request_revisions_record_valid
    CHECK (
      COALESCE((
      jsonb_typeof(record) = 'object'
      AND record ?& ARRAY[
        'schemaVersion',
        'version',
        'id',
        'roomId',
        'status',
        'statusReason',
        'startsAt',
        'endsAt',
        'internalParticipants',
        'externalParticipants',
        'statusChangedAt',
        'createdAt',
        'updatedAt',
        'details',
        'pricing',
        'configurationRevisions',
        'policy',
        'allocations'
      ]
      AND record - ARRAY[
        'schemaVersion',
        'version',
        'id',
        'roomId',
        'status',
        'statusReason',
        'startsAt',
        'endsAt',
        'internalParticipants',
        'externalParticipants',
        'statusChangedAt',
        'createdAt',
        'updatedAt',
        'details',
        'pricing',
        'configurationRevisions',
        'policy',
        'allocations'
      ] = '{}'::JSONB
      AND jsonb_typeof(record -> 'schemaVersion') = 'number'
      AND (record ->> 'schemaVersion') ~ '^[0-9]+$'
      AND jsonb_typeof(record -> 'version') = 'number'
      AND (record ->> 'version') ~ '^[0-9]+$'
      AND jsonb_typeof(record -> 'id') = 'string'
      AND jsonb_typeof(record -> 'roomId') IN ('string', 'null')
      AND jsonb_typeof(record -> 'status') = 'string'
      AND record ->> 'status' IN (
        'Submitted',
        'In Review',
        'Confirmed',
        'Rejected',
        'Change Requested',
        'Cancelled'
      )
      AND (
        (
          record ->> 'status' IN ('Rejected', 'Change Requested')
          AND jsonb_typeof(record -> 'statusReason') = 'string'
        )
        OR (
          record ->> 'status' NOT IN ('Rejected', 'Change Requested')
          AND record -> 'statusReason' = 'null'::JSONB
        )
      )
      AND jsonb_typeof(record -> 'startsAt') = 'string'
      AND jsonb_typeof(record -> 'endsAt') = 'string'
      AND jsonb_typeof(record -> 'internalParticipants') = 'number'
      AND (record ->> 'internalParticipants') ~ '^[0-9]+$'
      AND jsonb_typeof(record -> 'externalParticipants') = 'number'
      AND (record ->> 'externalParticipants') ~ '^[0-9]+$'
      AND jsonb_typeof(record -> 'statusChangedAt') = 'string'
      AND jsonb_typeof(record -> 'createdAt') = 'string'
      AND jsonb_typeof(record -> 'updatedAt') = 'string'
      AND (record ->> 'schemaVersion')::SMALLINT = schema_version
      AND (record ->> 'version')::BIGINT = request_version
      AND record ->> 'id' = request_id
      AND (record ->> 'endsAt')::TIMESTAMPTZ > (record ->> 'startsAt')::TIMESTAMPTZ
      AND (record ->> 'updatedAt')::TIMESTAMPTZ >= (record ->> 'createdAt')::TIMESTAMPTZ
      AND (
        (
          schema_version = 1
          AND record -> 'details' = 'null'::JSONB
          AND record -> 'pricing' = 'null'::JSONB
          AND record -> 'configurationRevisions' = 'null'::JSONB
          AND record -> 'policy' = 'null'::JSONB
          AND record -> 'allocations' = 'null'::JSONB
        )
        OR (
          schema_version = 2
          AND jsonb_typeof(record -> 'roomId') = 'string'
          AND (record ->> 'internalParticipants')::BIGINT
            + (record ->> 'externalParticipants')::BIGINT BETWEEN 1 AND 500
          AND (record ->> 'endsAt')::TIMESTAMPTZ
            <= (record ->> 'startsAt')::TIMESTAMPTZ + INTERVAL '24 hours'
          AND jsonb_typeof(record -> 'details') = 'object'
          AND (record -> 'details') ?& ARRAY[
            'title',
            'specialRequirements',
            'dietaryRequirements',
            'serviceIds',
            'catering'
          ]
          AND (record -> 'details') - ARRAY[
            'title',
            'specialRequirements',
            'dietaryRequirements',
            'serviceIds',
            'catering'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{details,title}') = 'string'
          AND jsonb_typeof(record #> '{details,serviceIds}') = 'array'
          AND jsonb_typeof(record #> '{details,catering}') = 'object'
          AND (record #> '{details,catering}') ?& ARRAY[
            'participantCount',
            'packageSelection',
            'itemQuantities'
          ]
          AND (record #> '{details,catering}') - ARRAY[
            'participantCount',
            'packageSelection',
            'itemQuantities'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{details,catering,participantCount}') = 'number'
          AND (record #>> '{details,catering,participantCount}') ~ '^[0-9]+$'
          AND (record #>> '{details,catering,participantCount}')::BIGINT
            <= (record ->> 'internalParticipants')::BIGINT
              + (record ->> 'externalParticipants')::BIGINT
          AND jsonb_typeof(record #> '{details,catering,itemQuantities}') = 'array'
          AND jsonb_typeof(record -> 'pricing') = 'object'
          AND jsonb_typeof(record #> '{pricing,room,id}') = 'string'
          AND record #>> '{pricing,room,id}' = record ->> 'roomId'
          AND jsonb_typeof(record #> '{pricing,services}') = 'array'
          AND jsonb_typeof(record #> '{pricing,catering}') = 'object'
          AND jsonb_typeof(record -> 'configurationRevisions') = 'object'
          AND (record -> 'configurationRevisions') ?& ARRAY[
            'organization',
            'locations',
            'catalogue',
            'bookingPolicies',
            'costAllocation'
          ]
          AND (record -> 'configurationRevisions') - ARRAY[
            'organization',
            'locations',
            'catalogue',
            'bookingPolicies',
            'costAllocation'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{configurationRevisions,organization}') = 'number'
          AND jsonb_typeof(record #> '{configurationRevisions,locations}') = 'number'
          AND jsonb_typeof(record #> '{configurationRevisions,catalogue}') = 'number'
          AND jsonb_typeof(record #> '{configurationRevisions,bookingPolicies}') = 'number'
          AND jsonb_typeof(record #> '{configurationRevisions,costAllocation}') = 'number'
          AND jsonb_typeof(record -> 'policy') = 'object'
          AND jsonb_typeof(record -> 'allocations') = 'object'
        )
      )
      AND octet_length(record::TEXT) <= 524288
      ), FALSE)
    ),
  CONSTRAINT request_revisions_actor_context_valid
    CHECK (
      (actor_user_id IS NULL AND correlation_id IS NULL)
      OR (actor_user_id IS NOT NULL AND correlation_id IS NOT NULL)
    ),
  CONSTRAINT request_revisions_migration_seed_valid
    CHECK (
      operation <> 'migrated_legacy'
      OR (
        request_version = 1
        AND schema_version = 1
        AND actor_user_id IS NULL
        AND correlation_id IS NULL
      )
    )
);

CREATE INDEX request_revisions_history_idx
  ON request_revisions (tenant_id, request_id, request_version DESC);

CREATE TRIGGER request_revisions_append_only
BEFORE UPDATE OR DELETE ON request_revisions
FOR EACH ROW
EXECUTE FUNCTION reject_tenant_configuration_revision_mutation();

INSERT INTO request_revisions (
  tenant_id,
  request_id,
  request_version,
  schema_version,
  operation,
  record,
  captured_at,
  actor_user_id,
  correlation_id
)
SELECT
  tenant_id,
  id,
  1,
  1,
  'migrated_legacy',
  jsonb_build_object(
    'schemaVersion', 1,
    'version', 1,
    'id', id,
    'roomId', room_id,
    'status', status,
    'statusReason', status_reason,
    'startsAt', to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt', to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'internalParticipants', internal_participants,
    'externalParticipants', external_participants,
    'statusChangedAt', to_char(status_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'details', NULL,
    'pricing', NULL,
    'configurationRevisions', NULL,
    'policy', NULL,
    'allocations', NULL
  ),
  updated_at,
  NULL,
  NULL
FROM requests;

UPDATE requests request
SET current_revision_sequence = revision.revision_sequence
FROM request_revisions revision
WHERE revision.tenant_id = request.tenant_id
  AND revision.request_id = request.id
  AND revision.request_version = request.request_version;

ALTER TABLE requests
  ADD CONSTRAINT requests_current_revision_fk
    FOREIGN KEY (current_revision_sequence)
    REFERENCES request_revisions(revision_sequence)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION enforce_request_revision_pointer_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  scoped_tenant_id UUID;
  scoped_request_id VARCHAR(128);
  current_schema_version SMALLINT;
  current_request_version BIGINT;
  current_revision_sequence BIGINT;
  latest_revision_sequence BIGINT;
  current_record JSONB;
BEGIN
  IF TG_TABLE_NAME = 'requests' THEN
    scoped_tenant_id := NEW.tenant_id;
    scoped_request_id := NEW.id;
  ELSE
    scoped_tenant_id := NEW.tenant_id;
    scoped_request_id := NEW.request_id;
  END IF;

  SELECT
    request.schema_version,
    request.request_version,
    request.current_revision_sequence
  INTO
    current_schema_version,
    current_request_version,
    current_revision_sequence
  FROM requests request
  WHERE request.tenant_id = scoped_tenant_id
    AND request.id = scoped_request_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT MAX(revision.revision_sequence)
  INTO latest_revision_sequence
  FROM request_revisions revision
  WHERE revision.tenant_id = scoped_tenant_id
    AND revision.request_id = scoped_request_id;

  IF current_revision_sequence IS NULL
     OR latest_revision_sequence IS NULL
     OR current_revision_sequence <> latest_revision_sequence
     OR NOT EXISTS (
       SELECT 1
       FROM request_revisions revision
       WHERE revision.tenant_id = scoped_tenant_id
         AND revision.request_id = scoped_request_id
         AND revision.revision_sequence = current_revision_sequence
         AND revision.request_version = current_request_version
         AND revision.schema_version = current_schema_version
     ) THEN
    RAISE EXCEPTION 'REQUEST_CURRENT_REVISION_INVALID'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision.record
  INTO current_record
  FROM request_revisions revision
  WHERE revision.tenant_id = scoped_tenant_id
    AND revision.request_id = scoped_request_id
    AND revision.revision_sequence = current_revision_sequence;

  IF current_record ->> 'roomId' IS DISTINCT FROM (
       SELECT room_id FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR current_record ->> 'status' IS DISTINCT FROM (
       SELECT status FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR current_record ->> 'statusReason' IS DISTINCT FROM (
       SELECT status_reason FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'startsAt')::TIMESTAMPTZ IS DISTINCT FROM (
       SELECT starts_at FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'endsAt')::TIMESTAMPTZ IS DISTINCT FROM (
       SELECT ends_at FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'internalParticipants')::INTEGER IS DISTINCT FROM (
       SELECT internal_participants FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'externalParticipants')::INTEGER IS DISTINCT FROM (
       SELECT external_participants FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'statusChangedAt')::TIMESTAMPTZ IS DISTINCT FROM (
       SELECT status_changed_at FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'createdAt')::TIMESTAMPTZ IS DISTINCT FROM (
       SELECT created_at FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
     OR (current_record ->> 'updatedAt')::TIMESTAMPTZ IS DISTINCT FROM (
       SELECT updated_at FROM requests
       WHERE tenant_id = scoped_tenant_id AND id = scoped_request_id
     )
  THEN
    RAISE EXCEPTION 'REQUEST_CURRENT_REVISION_RECORD_MISMATCH'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER requests_current_revision_integrity
AFTER INSERT OR UPDATE ON requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_request_revision_pointer_integrity();

CREATE CONSTRAINT TRIGGER request_revisions_current_pointer_integrity
AFTER INSERT ON request_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_request_revision_pointer_integrity();

ALTER TABLE booking_change_requests
  DROP CONSTRAINT booking_change_status_valid,
  ADD CONSTRAINT booking_change_status_valid
    CHECK (status IN ('pending', 'applying', 'applied', 'rejected', 'superseded')),
  ADD CONSTRAINT booking_change_superseded_valid
    CHECK (
      status <> 'superseded'
      OR (decided_by_user_id IS NOT NULL AND rejection_reason IS NULL)
    );

ALTER TABLE booking_change_requests
  ADD COLUMN request_schema_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN base_request_version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN request_draft JSONB,
  ADD COLUMN proposed_request_snapshot JSONB,
  ADD COLUMN move_attempt_number INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN recovery_phase VARCHAR(32) NOT NULL DEFAULT 'none',
  ADD COLUMN calendar_replacement JSONB,
  ADD CONSTRAINT booking_change_room_fk
    FOREIGN KEY (tenant_id, room_id)
    REFERENCES rooms(tenant_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT booking_change_request_schema_valid
    CHECK (request_schema_version IN (1, 2)),
  ADD CONSTRAINT booking_change_base_request_version_positive
    CHECK (base_request_version BETWEEN 1 AND 9007199254740989),
  ADD CONSTRAINT booking_change_move_attempt_number_valid
    CHECK (move_attempt_number BETWEEN 0 AND 2147483647),
  ADD CONSTRAINT booking_change_recovery_phase_valid
    CHECK (recovery_phase IN (
      'none',
      'move_pending',
      'target_active',
      'restore_pending',
      'reconciliation_required'
    )),
  ADD CONSTRAINT booking_change_calendar_replacement_valid
    CHECK (
      calendar_replacement IS NULL
      OR COALESCE((
        jsonb_typeof(calendar_replacement) = 'object'
        AND calendar_replacement ?& ARRAY[
          'idempotencyKey',
          'integrationId',
          'previousProviderReference',
          'previousProviderResourceReference',
          'providerReference',
          'providerResourceReference'
        ]
        AND calendar_replacement - ARRAY[
          'idempotencyKey',
          'integrationId',
          'previousProviderReference',
          'previousProviderResourceReference',
          'providerReference',
          'providerResourceReference'
        ] = '{}'::JSONB
        AND jsonb_typeof(calendar_replacement -> 'idempotencyKey') = 'string'
        AND calendar_replacement ->> 'idempotencyKey' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(calendar_replacement -> 'integrationId') = 'string'
        AND calendar_replacement ->> 'integrationId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND jsonb_typeof(calendar_replacement -> 'previousProviderReference') = 'string'
        AND char_length(calendar_replacement ->> 'previousProviderReference') BETWEEN 1 AND 255
        AND btrim(calendar_replacement ->> 'previousProviderReference')
          = calendar_replacement ->> 'previousProviderReference'
        AND calendar_replacement ->> 'previousProviderReference' !~ '[[:cntrl:]]'
        AND jsonb_typeof(
          calendar_replacement -> 'previousProviderResourceReference'
        ) = 'string'
        AND char_length(
          calendar_replacement ->> 'previousProviderResourceReference'
        ) BETWEEN 3 AND 320
        AND btrim(calendar_replacement ->> 'previousProviderResourceReference')
          = calendar_replacement ->> 'previousProviderResourceReference'
        AND calendar_replacement ->> 'previousProviderResourceReference' !~ '[[:cntrl:]]'
        AND jsonb_typeof(calendar_replacement -> 'providerReference') = 'string'
        AND char_length(calendar_replacement ->> 'providerReference') BETWEEN 1 AND 255
        AND btrim(calendar_replacement ->> 'providerReference')
          = calendar_replacement ->> 'providerReference'
        AND calendar_replacement ->> 'providerReference' !~ '[[:cntrl:]]'
        AND jsonb_typeof(calendar_replacement -> 'providerResourceReference') = 'string'
        AND char_length(calendar_replacement ->> 'providerResourceReference') BETWEEN 3 AND 320
        AND btrim(calendar_replacement ->> 'providerResourceReference')
          = calendar_replacement ->> 'providerResourceReference'
        AND calendar_replacement ->> 'providerResourceReference' !~ '[[:cntrl:]]'
        AND octet_length(calendar_replacement::TEXT) <= 4096
      ), FALSE)
    ),
  ADD CONSTRAINT booking_change_calendar_recovery_valid
    CHECK (
      (
        status <> 'applying'
        AND recovery_phase = 'none'
        AND calendar_replacement IS NULL
      )
      OR (
        status = 'applying'
        AND (
          (
            recovery_phase = 'none'
            AND calendar_replacement IS NULL
          )
          OR (
            recovery_phase = 'move_pending'
            AND move_attempt_number >= 1
            AND calendar_replacement IS NULL
          )
          OR (
            recovery_phase IN ('target_active', 'restore_pending')
            AND move_attempt_number >= 1
            AND calendar_replacement IS NOT NULL
          )
          OR (
            recovery_phase = 'reconciliation_required'
            AND move_attempt_number >= 1
          )
        )
      )
    ),
  ADD CONSTRAINT booking_change_v2_participant_limit
    CHECK (
      request_schema_version = 1
      OR internal_participants::BIGINT + external_participants::BIGINT BETWEEN 1 AND 500
    ),
  ADD CONSTRAINT booking_change_v2_schedule_limit
    CHECK (
      request_schema_version = 1
      OR ends_at <= starts_at + INTERVAL '24 hours'
    ),
  ADD CONSTRAINT booking_change_request_composition_valid
    CHECK (
      (
        request_schema_version = 1
        AND request_draft IS NULL
        AND proposed_request_snapshot IS NULL
      )
      OR COALESCE((
        request_schema_version = 2
        AND request_draft IS NOT NULL
        AND proposed_request_snapshot IS NOT NULL
        AND jsonb_typeof(request_draft) = 'object'
        AND request_draft ?& ARRAY[
          'title',
          'roomId',
          'startsAt',
          'endsAt',
          'internalParticipants',
          'externalParticipants',
          'serviceIds',
          'catering',
          'dietaryRequirements',
          'specialRequirements',
          'allocations',
          'configurationRevisions'
        ]
        AND request_draft - ARRAY[
          'title',
          'roomId',
          'startsAt',
          'endsAt',
          'internalParticipants',
          'externalParticipants',
          'serviceIds',
          'catering',
          'dietaryRequirements',
          'specialRequirements',
          'allocations',
          'configurationRevisions'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_draft -> 'title') = 'string'
        AND jsonb_typeof(request_draft -> 'roomId') = 'string'
        AND request_draft ->> 'roomId' = room_id
        AND jsonb_typeof(request_draft -> 'startsAt') = 'string'
        AND (request_draft ->> 'startsAt')::TIMESTAMPTZ = starts_at
        AND jsonb_typeof(request_draft -> 'endsAt') = 'string'
        AND (request_draft ->> 'endsAt')::TIMESTAMPTZ = ends_at
        AND jsonb_typeof(request_draft -> 'internalParticipants') = 'number'
        AND (request_draft ->> 'internalParticipants') ~ '^[0-9]+$'
        AND (request_draft ->> 'internalParticipants')::INTEGER = internal_participants
        AND jsonb_typeof(request_draft -> 'externalParticipants') = 'number'
        AND (request_draft ->> 'externalParticipants') ~ '^[0-9]+$'
        AND (request_draft ->> 'externalParticipants')::INTEGER = external_participants
        AND jsonb_typeof(request_draft -> 'serviceIds') = 'array'
        AND jsonb_typeof(request_draft -> 'catering') = 'object'
        AND (request_draft -> 'catering') ?& ARRAY[
          'participantCount',
          'packageSelection',
          'itemQuantities'
        ]
        AND (request_draft -> 'catering') - ARRAY[
          'participantCount',
          'packageSelection',
          'itemQuantities'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_draft #> '{catering,participantCount}') = 'number'
        AND (request_draft #>> '{catering,participantCount}') ~ '^[0-9]+$'
        AND (request_draft #>> '{catering,participantCount}')::BIGINT
          <= internal_participants::BIGINT + external_participants::BIGINT
        AND jsonb_typeof(request_draft #> '{catering,itemQuantities}') = 'array'
        AND (
          request_draft #> '{catering,packageSelection}' = 'null'::JSONB
          OR (
            jsonb_typeof(request_draft #> '{catering,packageSelection}') = 'object'
            AND (request_draft #> '{catering,packageSelection}') ?& ARRAY[
              'packageId',
              'variantId'
            ]
            AND (request_draft #> '{catering,packageSelection}') - ARRAY[
              'packageId',
              'variantId'
            ] = '{}'::JSONB
            AND jsonb_typeof(request_draft #> '{catering,packageSelection,packageId}') = 'string'
            AND jsonb_typeof(request_draft #> '{catering,packageSelection,variantId}') = 'string'
          )
        )
        AND jsonb_typeof(request_draft -> 'dietaryRequirements') IN ('string', 'null')
        AND jsonb_typeof(request_draft -> 'specialRequirements') IN ('string', 'null')
        AND jsonb_typeof(request_draft -> 'allocations') = 'array'
        AND jsonb_typeof(request_draft -> 'configurationRevisions') = 'object'
        AND (request_draft -> 'configurationRevisions') ?& ARRAY[
          'organization',
          'locations',
          'catalogue',
          'bookingPolicies',
          'costAllocation'
        ]
        AND (request_draft -> 'configurationRevisions') - ARRAY[
          'organization',
          'locations',
          'catalogue',
          'bookingPolicies',
          'costAllocation'
        ] = '{}'::JSONB
        AND jsonb_typeof(request_draft #> '{configurationRevisions,organization}') = 'number'
        AND jsonb_typeof(request_draft #> '{configurationRevisions,locations}') = 'number'
        AND jsonb_typeof(request_draft #> '{configurationRevisions,catalogue}') = 'number'
        AND jsonb_typeof(request_draft #> '{configurationRevisions,bookingPolicies}') = 'number'
        AND jsonb_typeof(request_draft #> '{configurationRevisions,costAllocation}') = 'number'
        AND jsonb_typeof(proposed_request_snapshot) = 'object'
        AND proposed_request_snapshot ?& ARRAY[
          'schemaVersion',
          'requestVersion',
          'capturedAt',
          'configurationRevisions',
          'details',
          'pricing',
          'policy',
          'allocations'
        ]
        AND proposed_request_snapshot - ARRAY[
          'schemaVersion',
          'requestVersion',
          'capturedAt',
          'configurationRevisions',
          'details',
          'pricing',
          'policy',
          'allocations'
        ] = '{}'::JSONB
        AND jsonb_typeof(proposed_request_snapshot -> 'schemaVersion') = 'number'
        AND proposed_request_snapshot ->> 'schemaVersion' = '2'
        AND jsonb_typeof(proposed_request_snapshot -> 'requestVersion') = 'number'
        AND (proposed_request_snapshot ->> 'requestVersion') ~ '^[0-9]+$'
        AND (proposed_request_snapshot ->> 'requestVersion')::BIGINT
          = base_request_version + 1
        AND jsonb_typeof(proposed_request_snapshot -> 'capturedAt') = 'string'
        AND jsonb_typeof(proposed_request_snapshot -> 'configurationRevisions') = 'object'
        AND proposed_request_snapshot -> 'configurationRevisions'
          = request_draft -> 'configurationRevisions'
        AND jsonb_typeof(proposed_request_snapshot -> 'details') = 'object'
        AND proposed_request_snapshot -> 'details' = jsonb_build_object(
          'title', request_draft -> 'title',
          'specialRequirements', request_draft -> 'specialRequirements',
          'dietaryRequirements', request_draft -> 'dietaryRequirements',
          'serviceIds', request_draft -> 'serviceIds',
          'catering', request_draft -> 'catering'
        )
        AND jsonb_typeof(proposed_request_snapshot -> 'pricing') = 'object'
        AND (proposed_request_snapshot -> 'pricing') ?& ARRAY[
          'currency',
          'totalMinor',
          'breakdown',
          'room',
          'services',
          'catering'
        ]
        AND (proposed_request_snapshot -> 'pricing') - ARRAY[
          'currency',
          'totalMinor',
          'breakdown',
          'room',
          'services',
          'catering'
        ] = '{}'::JSONB
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,currency}') = 'string'
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,totalMinor}') = 'number'
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,room}') = 'object'
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,room,id}') = 'string'
        AND proposed_request_snapshot #>> '{pricing,room,id}' = room_id
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,services}') = 'array'
        AND jsonb_path_query_array(
          proposed_request_snapshot,
          '$.pricing.services[*].service.id'
        ) = request_draft -> 'serviceIds'
        AND jsonb_typeof(proposed_request_snapshot #> '{pricing,catering}') = 'object'
        AND (proposed_request_snapshot #> '{pricing,catering}') ?& ARRAY[
          'participantCount',
          'packageSelection',
          'items'
        ]
        AND (proposed_request_snapshot #> '{pricing,catering}') - ARRAY[
          'participantCount',
          'packageSelection',
          'items'
        ] = '{}'::JSONB
        AND proposed_request_snapshot #> '{pricing,catering,participantCount}'
          = request_draft #> '{catering,participantCount}'
        AND jsonb_path_query_array(
          proposed_request_snapshot,
          '$.pricing.catering.items[*].item.id'
        ) = jsonb_path_query_array(
          request_draft,
          '$.catering.itemQuantities[*].itemId'
        )
        AND jsonb_path_query_array(
          proposed_request_snapshot,
          '$.pricing.catering.items[*].quantity'
        ) = jsonb_path_query_array(
          request_draft,
          '$.catering.itemQuantities[*].quantity'
        )
        AND (
          (
            request_draft #> '{catering,packageSelection}' = 'null'::JSONB
            AND proposed_request_snapshot #> '{pricing,catering,packageSelection}'
              = 'null'::JSONB
          )
          OR (
            jsonb_typeof(proposed_request_snapshot #> '{pricing,catering,packageSelection}')
              = 'object'
            AND proposed_request_snapshot #>> '{pricing,catering,packageSelection,package,id}'
              = request_draft #>> '{catering,packageSelection,packageId}'
            AND proposed_request_snapshot #>> '{pricing,catering,packageSelection,variant,id}'
              = request_draft #>> '{catering,packageSelection,variantId}'
          )
        )
        AND jsonb_typeof(proposed_request_snapshot -> 'policy') = 'object'
        AND jsonb_typeof(proposed_request_snapshot #> '{policy,evaluatedAt}') = 'string'
        AND jsonb_typeof(proposed_request_snapshot -> 'allocations') = 'object'
        AND (proposed_request_snapshot -> 'allocations') ?& ARRAY[
          'schemaVersion',
          'configurationRevision',
          'snapshottedAt',
          'model',
          'totalBasisPoints',
          'totalMinor',
          'allocatedMinor',
          'unallocatedMinor',
          'currency',
          'entries'
        ]
        AND (proposed_request_snapshot -> 'allocations') - ARRAY[
          'schemaVersion',
          'configurationRevision',
          'snapshottedAt',
          'model',
          'totalBasisPoints',
          'totalMinor',
          'allocatedMinor',
          'unallocatedMinor',
          'currency',
          'entries'
        ] = '{}'::JSONB
        AND jsonb_typeof(proposed_request_snapshot #> '{allocations,entries}') = 'array'
        AND jsonb_path_query_array(
          proposed_request_snapshot,
          '$.allocations.entries[*].costCenterId'
        ) = jsonb_path_query_array(
          request_draft,
          '$.allocations[*].costCenterId'
        )
        AND jsonb_path_query_array(
          proposed_request_snapshot,
          '$.allocations.entries[*].percentageBasisPoints'
        ) = jsonb_path_query_array(
          request_draft,
          '$.allocations[*].percentageBasisPoints'
        )
        AND proposed_request_snapshot #> '{allocations,configurationRevision}'
          = request_draft #> '{configurationRevisions,costAllocation}'
        AND proposed_request_snapshot #> '{allocations,totalMinor}'
          = proposed_request_snapshot #> '{pricing,totalMinor}'
        AND proposed_request_snapshot #> '{allocations,currency}'
          = proposed_request_snapshot #> '{pricing,currency}'
        AND proposed_request_snapshot -> 'capturedAt'
          = proposed_request_snapshot #> '{policy,evaluatedAt}'
        AND proposed_request_snapshot -> 'capturedAt'
          = proposed_request_snapshot #> '{allocations,snapshottedAt}'
        AND (proposed_request_snapshot ->> 'capturedAt')::TIMESTAMPTZ = created_at
        AND octet_length(request_draft::TEXT) <= 131072
        AND octet_length(proposed_request_snapshot::TEXT) <= 524288
      ), FALSE)
    );

CREATE FUNCTION prevent_booking_change_proposal_identity_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.initiator_user_id IS DISTINCT FROM OLD.initiator_user_id
    OR NEW.room_id IS DISTINCT FROM OLD.room_id
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.internal_participants IS DISTINCT FROM OLD.internal_participants
    OR NEW.external_participants IS DISTINCT FROM OLD.external_participants
    OR NEW.base_request_updated_at IS DISTINCT FROM OLD.base_request_updated_at
    OR NEW.request_schema_version IS DISTINCT FROM OLD.request_schema_version
    OR NEW.base_request_version IS DISTINCT FROM OLD.base_request_version
    OR NEW.request_draft IS DISTINCT FROM OLD.request_draft
    OR NEW.proposed_request_snapshot IS DISTINCT FROM OLD.proposed_request_snapshot
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'booking change proposal identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_change_proposal_identity_immutable
BEFORE UPDATE ON booking_change_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_booking_change_proposal_identity_mutation();
