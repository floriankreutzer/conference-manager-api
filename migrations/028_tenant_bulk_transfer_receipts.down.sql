LOCK TABLE tenant_bulk_transfer_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_bulk_transfer_receipts LIMIT 1) THEN
    RAISE EXCEPTION 'TENANT_BULK_TRANSFER_RECEIPTS_REQUIRE_REVIEW' USING ERRCODE = '55000';
  END IF;
END;
$$;

DROP INDEX tenant_bulk_receipts_pending_expiry_idx;
DROP TABLE tenant_bulk_transfer_receipts;
