LOCK TABLE catering_integration_configurations, catering_integration_configuration_revisions IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM catering_integration_configurations)
    OR EXISTS (SELECT 1 FROM catering_integration_configuration_revisions) THEN
    RAISE EXCEPTION 'CATERING_CONFIGURATION_ROLLBACK_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END $$;
ALTER TABLE catering_integration_configurations DROP CONSTRAINT catering_configuration_current_revision_fk;
DROP TABLE catering_integration_configuration_revisions;
DROP TABLE catering_integration_configurations;
DROP FUNCTION guard_catering_configuration_revision();
