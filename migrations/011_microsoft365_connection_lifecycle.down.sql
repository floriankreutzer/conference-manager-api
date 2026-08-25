DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM microsoft365_consent_transactions LIMIT 1)
    OR EXISTS (SELECT 1 FROM integrations WHERE provider = 'microsoft365' LIMIT 1)
  THEN
    RAISE EXCEPTION 'MICROSOFT365_CONNECTION_ROWS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END
$$;

DROP INDEX microsoft365_consent_tenant_expiry_idx;
DROP TABLE microsoft365_consent_transactions;
DROP INDEX integrations_microsoft365_tenant_unique;

ALTER TABLE integrations
  DROP CONSTRAINT integrations_microsoft365_verified_order,
  DROP CONSTRAINT integrations_microsoft365_verified_state_valid,
  DROP CONSTRAINT integrations_microsoft365_reason_valid,
  DROP CONSTRAINT integrations_microsoft365_permission_status_valid,
  DROP CONSTRAINT integrations_microsoft365_status_valid,
  DROP CONSTRAINT integrations_microsoft365_version_valid,
  DROP CONSTRAINT integrations_microsoft365_reference_valid,
  DROP COLUMN calendars_permission_status,
  DROP COLUMN places_permission_status,
  DROP COLUMN connection_reason,
  DROP COLUMN last_verified_at,
  DROP COLUMN connection_version;
