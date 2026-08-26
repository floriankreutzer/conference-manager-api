DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking_provider_references LIMIT 1) THEN
    RAISE EXCEPTION 'BOOKING_PROVIDER_RESOURCE_BINDING_REQUIRES_REVIEW'
      USING ERRCODE = '55000';
  END IF;
END
$$;

ALTER TABLE booking_provider_references
  ALTER COLUMN provider_reference DROP NOT NULL,
  ADD COLUMN attempt_number integer NOT NULL,
  ADD COLUMN provider_connection_reference varchar(320) NOT NULL,
  ADD COLUMN provider_resource_reference varchar(320) NOT NULL,
  ADD CONSTRAINT booking_provider_references_connection_reference_valid CHECK (
    char_length(provider_connection_reference) BETWEEN 3 AND 320
    AND provider_connection_reference = btrim(provider_connection_reference)
    AND provider_connection_reference !~ '[[:cntrl:]]'
  ),
  ADD CONSTRAINT booking_provider_references_attempt_number_valid CHECK (
    attempt_number BETWEEN 1 AND 2147483647
  ),
  ADD CONSTRAINT booking_provider_references_resource_reference_valid CHECK (
    char_length(provider_resource_reference) BETWEEN 3 AND 320
    AND provider_resource_reference = btrim(provider_resource_reference)
    AND provider_resource_reference !~ '[[:cntrl:]]'
  ),
  DROP CONSTRAINT booking_provider_references_state_valid,
  ADD CONSTRAINT booking_provider_references_state_valid CHECK (
    state IN ('pending', 'active', 'compensating', 'compensated', 'cancelled')
  ),
  ADD CONSTRAINT booking_provider_references_state_reference_valid CHECK (
    (state = 'pending' AND provider_reference IS NULL)
    OR (state IN ('active', 'compensating', 'compensated', 'cancelled') AND provider_reference IS NOT NULL)
  );
