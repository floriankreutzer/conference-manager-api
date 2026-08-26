LOCK TABLE booking_provider_references IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking_provider_references LIMIT 1) THEN
    RAISE EXCEPTION 'BOOKING_PROVIDER_RESOURCE_BINDING_ROWS_REQUIRE_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE booking_provider_references
  DROP CONSTRAINT booking_provider_references_state_reference_valid,
  DROP CONSTRAINT booking_provider_references_state_valid,
  ADD CONSTRAINT booking_provider_references_state_valid CHECK (
    state IN ('active', 'cancelled')
  ),
  DROP CONSTRAINT booking_provider_references_resource_reference_valid,
  DROP COLUMN provider_resource_reference,
  DROP CONSTRAINT booking_provider_references_connection_reference_valid,
  DROP COLUMN provider_connection_reference,
  DROP CONSTRAINT booking_provider_references_attempt_number_valid,
  DROP COLUMN attempt_number,
  ALTER COLUMN provider_reference SET NOT NULL;
