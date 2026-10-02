DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_bulk_transfer_receipts WHERE document_type = 'equipment') THEN
    RAISE EXCEPTION 'TENANT_BULK_EQUIPMENT_RECEIPTS_REQUIRE_REVIEW';
  END IF;
END;
$$;

ALTER TABLE tenant_bulk_transfer_receipts
  DROP CONSTRAINT tenant_bulk_receipt_type_valid;

ALTER TABLE tenant_bulk_transfer_receipts
  ADD CONSTRAINT tenant_bulk_receipt_type_valid
  CHECK (document_type IN ('sites', 'rooms', 'services', 'catering-items', 'catering-packages', 'cost-centers'));
