ALTER TABLE tenant_entitlements
  DROP CONSTRAINT tenant_entitlements_capability_valid;

ALTER TABLE tenant_entitlements
  ADD CONSTRAINT tenant_entitlements_capability_valid CHECK (
    capability_id IN (
      'microsoft.directory',
      'microsoft.calendar',
      'microsoft.calendar.write'
    )
  );
