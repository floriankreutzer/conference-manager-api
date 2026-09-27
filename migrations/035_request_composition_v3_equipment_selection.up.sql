ALTER TABLE requests
  DROP CONSTRAINT requests_schema_version_valid,
  DROP CONSTRAINT requests_snapshot_schema_valid,
  ADD CONSTRAINT requests_schema_version_valid
    CHECK (schema_version IN (1, 2, 3)),
  ADD CONSTRAINT requests_snapshot_schema_valid
    CHECK (
      (schema_version = 1 AND request_snapshot IS NULL)
      OR COALESCE((
        schema_version IN (2, 3)
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
        AND (
          (
            schema_version = 2
            AND request_snapshot ->> 'schemaVersion' = '2'
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
          )
          OR (
            schema_version = 3
            AND request_snapshot ->> 'schemaVersion' = '3'
            AND jsonb_typeof(request_snapshot -> 'details') = 'object'
            AND (request_snapshot -> 'details') ?& ARRAY[
              'title',
              'specialRequirements',
              'dietaryRequirements',
              'serviceIds',
              'equipmentIds',
              'catering'
            ]
            AND (request_snapshot -> 'details') - ARRAY[
              'title',
              'specialRequirements',
              'dietaryRequirements',
              'serviceIds',
              'equipmentIds',
              'catering'
            ] = '{}'::JSONB
            AND jsonb_typeof(request_snapshot #> '{details,title}') = 'string'
            AND jsonb_typeof(request_snapshot #> '{details,serviceIds}') = 'array'
            AND jsonb_typeof(request_snapshot #> '{details,equipmentIds}') = 'array'
            AND jsonb_array_length(request_snapshot #> '{details,equipmentIds}') <= 200
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
              'equipment',
              'catering'
            ]
            AND (request_snapshot -> 'pricing') - ARRAY[
              'currency',
              'totalMinor',
              'breakdown',
              'room',
              'services',
              'equipment',
              'catering'
            ] = '{}'::JSONB
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown}') = 'object'
            AND (request_snapshot #> '{pricing,breakdown}') ?& ARRAY[
              'roomMinor',
              'servicesMinor',
              'equipmentMinor',
              'cateringPackageMinor',
              'cateringItemsMinor'
            ]
            AND (request_snapshot #> '{pricing,breakdown}') - ARRAY[
              'roomMinor',
              'servicesMinor',
              'equipmentMinor',
              'cateringPackageMinor',
              'cateringItemsMinor'
            ] = '{}'::JSONB
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown,roomMinor}') = 'number'
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown,servicesMinor}') = 'number'
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown,equipmentMinor}') = 'number'
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown,cateringPackageMinor}') = 'number'
            AND jsonb_typeof(request_snapshot #> '{pricing,breakdown,cateringItemsMinor}') = 'number'
            AND jsonb_typeof(request_snapshot #> '{pricing,room}') = 'object'
            AND jsonb_typeof(request_snapshot #> '{pricing,room,id}') = 'string'
            AND jsonb_typeof(request_snapshot #> '{pricing,services}') = 'array'
            AND jsonb_typeof(request_snapshot #> '{pricing,equipment}') = 'array'
            AND jsonb_array_length(request_snapshot #> '{pricing,equipment}') <= 200
            AND jsonb_typeof(request_snapshot #> '{pricing,catering}') = 'object'
            AND jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].equipment.id'
            ) = request_snapshot #> '{details,equipmentIds}'
            AND jsonb_array_length(jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].lineTotalMinor'
            )) = jsonb_array_length(request_snapshot #> '{pricing,equipment}')
            AND jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].lineTotalMinor'
            ) = jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].equipment.price.amountMinor'
            )
            AND jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].keyvalue().key'
            ) <@ '["equipment", "lineTotalMinor"]'::JSONB
            AND jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].equipment.keyvalue().key'
            ) <@ '["id", "name", "description", "price"]'::JSONB
            AND jsonb_path_query_array(
              request_snapshot,
              '$.pricing.equipment[*].equipment.price.keyvalue().key'
            ) <@ '["amountMinor", "currency"]'::JSONB
          )
        )
        AND jsonb_typeof(request_snapshot -> 'policy') = 'object'
        AND jsonb_typeof(request_snapshot -> 'allocations') = 'object'
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
    CHECK (schema_version IN (1, 2, 3)),
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
        OR (
          schema_version = 3
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
            'equipmentIds',
            'catering'
          ]
          AND (record -> 'details') - ARRAY[
            'title',
            'specialRequirements',
            'dietaryRequirements',
            'serviceIds',
            'equipmentIds',
            'catering'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{details,title}') = 'string'
          AND jsonb_typeof(record #> '{details,serviceIds}') = 'array'
          AND jsonb_typeof(record #> '{details,equipmentIds}') = 'array'
          AND jsonb_array_length(record #> '{details,equipmentIds}') <= 200
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
          AND (record -> 'pricing') ?& ARRAY[
            'currency',
            'totalMinor',
            'breakdown',
            'room',
            'services',
            'equipment',
            'catering'
          ]
          AND (record -> 'pricing') - ARRAY[
            'currency',
            'totalMinor',
            'breakdown',
            'room',
            'services',
            'equipment',
            'catering'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{pricing,breakdown}') = 'object'
          AND (record #> '{pricing,breakdown}') ?& ARRAY[
            'roomMinor',
            'servicesMinor',
            'equipmentMinor',
            'cateringPackageMinor',
            'cateringItemsMinor'
          ]
          AND (record #> '{pricing,breakdown}') - ARRAY[
            'roomMinor',
            'servicesMinor',
            'equipmentMinor',
            'cateringPackageMinor',
            'cateringItemsMinor'
          ] = '{}'::JSONB
          AND jsonb_typeof(record #> '{pricing,breakdown,roomMinor}') = 'number'
          AND jsonb_typeof(record #> '{pricing,breakdown,servicesMinor}') = 'number'
          AND jsonb_typeof(record #> '{pricing,breakdown,equipmentMinor}') = 'number'
          AND jsonb_typeof(record #> '{pricing,breakdown,cateringPackageMinor}') = 'number'
          AND jsonb_typeof(record #> '{pricing,breakdown,cateringItemsMinor}') = 'number'
          AND jsonb_typeof(record #> '{pricing,room,id}') = 'string'
          AND record #>> '{pricing,room,id}' = record ->> 'roomId'
          AND jsonb_typeof(record #> '{pricing,services}') = 'array'
          AND jsonb_typeof(record #> '{pricing,equipment}') = 'array'
          AND jsonb_array_length(record #> '{pricing,equipment}') <= 200
          AND jsonb_typeof(record #> '{pricing,catering}') = 'object'
          AND jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].equipment.id'
          ) = record #> '{details,equipmentIds}'
          AND jsonb_array_length(jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].lineTotalMinor'
          )) = jsonb_array_length(record #> '{pricing,equipment}')
          AND jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].lineTotalMinor'
          ) = jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].equipment.price.amountMinor'
          )
          AND jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].keyvalue().key'
          ) <@ '["equipment", "lineTotalMinor"]'::JSONB
          AND jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].equipment.keyvalue().key'
          ) <@ '["id", "name", "description", "price"]'::JSONB
          AND jsonb_path_query_array(
            record,
            '$.pricing.equipment[*].equipment.price.keyvalue().key'
          ) <@ '["amountMinor", "currency"]'::JSONB
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
    CHECK (request_schema_version IN (1, 2, 3)),
  ADD CONSTRAINT booking_change_request_composition_valid
    CHECK (
      (
        request_schema_version = 1
        AND request_draft IS NULL
        AND proposed_request_snapshot IS NULL
      )
      OR COALESCE((
        request_schema_version IN (2, 3)
        AND request_draft IS NOT NULL
        AND proposed_request_snapshot IS NOT NULL
        AND jsonb_typeof(request_draft) = 'object'
        AND (
          (
            request_schema_version = 2
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
          )
          OR (
            request_schema_version = 3
            AND request_draft ?& ARRAY[
              'title',
              'roomId',
              'startsAt',
              'endsAt',
              'internalParticipants',
              'externalParticipants',
              'serviceIds',
              'equipmentIds',
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
              'equipmentIds',
              'catering',
              'dietaryRequirements',
              'specialRequirements',
              'allocations',
              'configurationRevisions'
            ] = '{}'::JSONB
            AND jsonb_typeof(request_draft -> 'equipmentIds') = 'array'
            AND jsonb_array_length(request_draft -> 'equipmentIds') <= 200
          )
        )
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
        AND (
          (
            request_schema_version = 2
            AND proposed_request_snapshot ->> 'schemaVersion' = '2'
            AND proposed_request_snapshot -> 'details' = jsonb_build_object(
              'title', request_draft -> 'title',
              'specialRequirements', request_draft -> 'specialRequirements',
              'dietaryRequirements', request_draft -> 'dietaryRequirements',
              'serviceIds', request_draft -> 'serviceIds',
              'catering', request_draft -> 'catering'
            )
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
          )
          OR (
            request_schema_version = 3
            AND proposed_request_snapshot ->> 'schemaVersion' = '3'
            AND proposed_request_snapshot -> 'details' = jsonb_build_object(
              'title', request_draft -> 'title',
              'specialRequirements', request_draft -> 'specialRequirements',
              'dietaryRequirements', request_draft -> 'dietaryRequirements',
              'serviceIds', request_draft -> 'serviceIds',
              'equipmentIds', request_draft -> 'equipmentIds',
              'catering', request_draft -> 'catering'
            )
            AND (proposed_request_snapshot -> 'pricing') ?& ARRAY[
              'currency',
              'totalMinor',
              'breakdown',
              'room',
              'services',
              'equipment',
              'catering'
            ]
            AND (proposed_request_snapshot -> 'pricing') - ARRAY[
              'currency',
              'totalMinor',
              'breakdown',
              'room',
              'services',
              'equipment',
              'catering'
            ] = '{}'::JSONB
            AND jsonb_typeof(proposed_request_snapshot #> '{pricing,breakdown}') = 'object'
            AND (proposed_request_snapshot #> '{pricing,breakdown}') ?& ARRAY[
              'roomMinor',
              'servicesMinor',
              'equipmentMinor',
              'cateringPackageMinor',
              'cateringItemsMinor'
            ]
            AND (proposed_request_snapshot #> '{pricing,breakdown}') - ARRAY[
              'roomMinor',
              'servicesMinor',
              'equipmentMinor',
              'cateringPackageMinor',
              'cateringItemsMinor'
            ] = '{}'::JSONB
            AND jsonb_typeof(proposed_request_snapshot #> '{pricing,breakdown,roomMinor}') = 'number'
            AND jsonb_typeof(proposed_request_snapshot #> '{pricing,breakdown,servicesMinor}') = 'number'
            AND jsonb_typeof(proposed_request_snapshot #> '{pricing,breakdown,equipmentMinor}') = 'number'
            AND jsonb_typeof(
              proposed_request_snapshot #> '{pricing,breakdown,cateringPackageMinor}'
            ) = 'number'
            AND jsonb_typeof(
              proposed_request_snapshot #> '{pricing,breakdown,cateringItemsMinor}'
            ) = 'number'
            AND jsonb_typeof(proposed_request_snapshot #> '{pricing,equipment}') = 'array'
            AND jsonb_array_length(proposed_request_snapshot #> '{pricing,equipment}') <= 200
            AND jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].equipment.id'
            ) = request_draft -> 'equipmentIds'
            AND jsonb_array_length(jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].lineTotalMinor'
            )) = jsonb_array_length(proposed_request_snapshot #> '{pricing,equipment}')
            AND jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].lineTotalMinor'
            ) = jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].equipment.price.amountMinor'
            )
            AND jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].keyvalue().key'
            ) <@ '["equipment", "lineTotalMinor"]'::JSONB
            AND jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].equipment.keyvalue().key'
            ) <@ '["id", "name", "description", "price"]'::JSONB
            AND jsonb_path_query_array(
              proposed_request_snapshot,
              '$.pricing.equipment[*].equipment.price.keyvalue().key'
            ) <@ '["amountMinor", "currency"]'::JSONB
          )
        )
        AND jsonb_typeof(proposed_request_snapshot -> 'requestVersion') = 'number'
        AND (proposed_request_snapshot ->> 'requestVersion') ~ '^[0-9]+$'
        AND (proposed_request_snapshot ->> 'requestVersion')::BIGINT
          = base_request_version + 1
        AND jsonb_typeof(proposed_request_snapshot -> 'capturedAt') = 'string'
        AND jsonb_typeof(proposed_request_snapshot -> 'configurationRevisions') = 'object'
        AND proposed_request_snapshot -> 'configurationRevisions'
          = request_draft -> 'configurationRevisions'
        AND jsonb_typeof(proposed_request_snapshot -> 'details') = 'object'
        AND jsonb_typeof(proposed_request_snapshot -> 'pricing') = 'object'
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

-- Equipment is a positive additive snapshot contract; no historical row is rewritten.
CREATE FUNCTION request_equipment_snapshot_valid(composition_schema INTEGER, details JSONB, pricing JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  line JSONB;
  entry JSONB;
  amount NUMERIC;
  equipment_total NUMERIC := 0;
  total NUMERIC := 0;
  identifier TEXT;
  identifiers TEXT[] := ARRAY[]::TEXT[];
  sorted_identifiers TEXT[];
  currencies TEXT[] := ARRAY[]::TEXT[];
  money JSONB;
  breakdown_key TEXT;
BEGIN
  IF composition_schema = 1 THEN RETURN TRUE; END IF;
  IF composition_schema = 2 THEN
    RETURN COALESCE(NOT (details ? 'equipmentIds')
      AND NOT (pricing ? 'equipment') AND NOT ((pricing -> 'breakdown') ? 'equipmentMinor'), FALSE);
  END IF;
  IF composition_schema <> 3 OR jsonb_typeof(details -> 'equipmentIds') IS DISTINCT FROM 'array'
    OR jsonb_typeof(pricing -> 'equipment') IS DISTINCT FROM 'array'
    OR jsonb_array_length(details -> 'equipmentIds') > 200
    OR jsonb_array_length(pricing -> 'equipment') > 200 THEN RETURN FALSE; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(pricing -> 'equipment') LOOP
    IF jsonb_typeof(line) IS DISTINCT FROM 'object'
      OR NOT (line ?& ARRAY['equipment','lineTotalMinor'])
      OR line - ARRAY['equipment','lineTotalMinor'] <> '{}'::JSONB THEN RETURN FALSE; END IF;
    entry := line -> 'equipment';
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR NOT (entry ?& ARRAY['id','name','description','price'])
      OR entry - ARRAY['id','name','description','price'] <> '{}'::JSONB
      OR jsonb_typeof(entry -> 'id') IS DISTINCT FROM 'string'
      OR (entry ->> 'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR jsonb_typeof(entry -> 'name') IS DISTINCT FROM 'string'
      OR length(entry ->> 'name') NOT BETWEEN 1 AND 160
      OR (entry ->> 'name') <> btrim(entry ->> 'name')
      OR jsonb_typeof(entry -> 'description') NOT IN ('null','string')
      OR length(entry ->> 'description') > 2000 THEN RETURN FALSE; END IF;
    money := entry -> 'price';
    IF jsonb_typeof(money) IS DISTINCT FROM 'object'
      OR NOT (money ?& ARRAY['currency','amountMinor'])
      OR money - ARRAY['currency','amountMinor'] <> '{}'::JSONB
      OR jsonb_typeof(money -> 'currency') IS DISTINCT FROM 'string'
      OR money ->> 'currency' NOT IN ('CHF','EUR','GBP','USD')
      OR jsonb_typeof(money -> 'amountMinor') IS DISTINCT FROM 'number'
      OR (money ->> 'amountMinor') !~ '^[0-9]+$'
      OR jsonb_typeof(line -> 'lineTotalMinor') IS DISTINCT FROM 'number'
      OR line -> 'lineTotalMinor' <> money -> 'amountMinor' THEN RETURN FALSE; END IF;
    amount := (money ->> 'amountMinor')::NUMERIC;
    IF amount > 1000000000 THEN RETURN FALSE; END IF;
    identifier := entry ->> 'id';
    IF identifier = ANY(identifiers) THEN RETURN FALSE; END IF;
    identifiers := array_append(identifiers, identifier);
    equipment_total := equipment_total + amount;
    currencies := array_append(currencies, money ->> 'currency');
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id COLLATE "C"), ARRAY[]::TEXT[])
    INTO sorted_identifiers FROM unnest(identifiers) AS ids(id);
  IF identifiers <> sorted_identifiers OR details -> 'equipmentIds' <> to_jsonb(identifiers)
    OR pricing #> '{breakdown,equipmentMinor}' <> to_jsonb(equipment_total)
    OR jsonb_typeof(pricing -> 'totalMinor') IS DISTINCT FROM 'number'
    OR (pricing ->> 'totalMinor') !~ '^[0-9]+$'
    OR jsonb_typeof(pricing -> 'currency') IS DISTINCT FROM 'string'
    OR pricing ->> 'currency' NOT IN ('CHF','EUR','GBP','USD') THEN RETURN FALSE; END IF;
  FOREACH breakdown_key IN ARRAY ARRAY['roomMinor','servicesMinor','equipmentMinor','cateringPackageMinor','cateringItemsMinor'] LOOP
    IF jsonb_typeof(pricing -> 'breakdown' -> breakdown_key) IS DISTINCT FROM 'number'
      OR (pricing -> 'breakdown' ->> breakdown_key) !~ '^[0-9]+$' THEN RETURN FALSE; END IF;
    total := total + (pricing -> 'breakdown' ->> breakdown_key)::NUMERIC;
  END LOOP;
  IF total > 9007199254740991 OR total <> (pricing ->> 'totalMinor')::NUMERIC THEN RETURN FALSE; END IF;
  -- Zero-priced charge lines still take part in the single-currency invariant.
  currencies := array_append(currencies, pricing #>> '{room,price,currency}');
  FOR money IN SELECT jsonb_path_query(pricing, '$.services[*].service.price') LOOP
    currencies := array_append(currencies, money ->> 'currency');
  END LOOP;
  IF pricing #> '{catering,packageSelection}' <> 'null'::JSONB THEN
    currencies := array_append(currencies, pricing #>> '{catering,packageSelection,variant,price,currency}');
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(pricing #> '{catering,items}') LOOP
    IF line -> 'includedByPackage' = 'false'::JSONB THEN
      currencies := array_append(currencies, line #>> '{item,price,currency}');
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM unnest(currencies) AS currency_values(currency)
    WHERE currency IS NULL OR currency <> currencies[1]) THEN RETURN FALSE; END IF;
  RETURN total = 0 OR pricing ->> 'currency' = currencies[1];
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;

ALTER TABLE requests ADD CONSTRAINT requests_equipment_snapshot_valid
  CHECK (request_equipment_snapshot_valid(schema_version, request_snapshot -> 'details', request_snapshot -> 'pricing'));
ALTER TABLE request_revisions ADD CONSTRAINT request_revisions_equipment_snapshot_valid
  CHECK (request_equipment_snapshot_valid(schema_version, record -> 'details', record -> 'pricing'));
ALTER TABLE booking_change_requests ADD CONSTRAINT booking_change_equipment_snapshot_valid
  CHECK (request_equipment_snapshot_valid(request_schema_version,
    proposed_request_snapshot -> 'details', proposed_request_snapshot -> 'pricing'));
