LOCK TABLE requests IN ACCESS EXCLUSIVE MODE;
LOCK TABLE request_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE booking_change_requests IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM requests
    WHERE schema_version = 3
       OR request_snapshot ->> 'schemaVersion' = '3'
       OR (request_snapshot -> 'details') ? 'equipmentIds'
       OR (request_snapshot -> 'pricing') ? 'equipment'
       OR (request_snapshot #> '{pricing,breakdown}') ? 'equipmentMinor'
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM request_revisions
    WHERE schema_version = 3
       OR record ->> 'schemaVersion' = '3'
       OR (record -> 'details') ? 'equipmentIds'
       OR (record -> 'pricing') ? 'equipment'
       OR (record #> '{pricing,breakdown}') ? 'equipmentMinor'
    LIMIT 1
  ) OR EXISTS (
    SELECT 1
    FROM booking_change_requests
    WHERE request_schema_version = 3
       OR request_draft ? 'equipmentIds'
       OR proposed_request_snapshot ->> 'schemaVersion' = '3'
       OR (proposed_request_snapshot -> 'details') ? 'equipmentIds'
       OR (proposed_request_snapshot -> 'pricing') ? 'equipment'
       OR (proposed_request_snapshot #> '{pricing,breakdown}') ? 'equipmentMinor'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'REQUEST_COMPOSITION_V3_ROLLBACK_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE requests DROP CONSTRAINT requests_equipment_snapshot_valid;
ALTER TABLE request_revisions DROP CONSTRAINT request_revisions_equipment_snapshot_valid;
ALTER TABLE booking_change_requests DROP CONSTRAINT booking_change_equipment_snapshot_valid;
DROP FUNCTION request_equipment_snapshot_valid(INTEGER, JSONB, JSONB);

ALTER TABLE requests
  DROP CONSTRAINT requests_schema_version_valid,
  DROP CONSTRAINT requests_snapshot_schema_valid,
  ADD CONSTRAINT requests_schema_version_valid
    CHECK (schema_version IN (1, 2)),
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
    );

ALTER TABLE request_revisions
  DROP CONSTRAINT request_revisions_schema_valid,
  DROP CONSTRAINT request_revisions_record_valid,
  ADD CONSTRAINT request_revisions_schema_valid
    CHECK (schema_version IN (1, 2)),
  ADD CONSTRAINT request_revisions_record_valid
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
    );

ALTER TABLE booking_change_requests
  DROP CONSTRAINT booking_change_request_schema_valid,
  DROP CONSTRAINT booking_change_request_composition_valid,
  ADD CONSTRAINT booking_change_request_schema_valid
    CHECK (request_schema_version IN (1, 2)),
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
