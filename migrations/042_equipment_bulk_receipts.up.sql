ALTER TABLE tenant_bulk_transfer_receipts
  DROP CONSTRAINT tenant_bulk_receipt_type_valid,
  ADD CONSTRAINT tenant_bulk_receipt_type_valid
    CHECK (document_type IN ('sites', 'rooms', 'services', 'equipment', 'catering-items', 'catering-packages', 'cost-centers'));
