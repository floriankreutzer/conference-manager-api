LOCK TABLE platform_passkey_credentials, platform_passkey_auth_transactions IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_passkey_credentials)
     OR EXISTS (SELECT 1 FROM platform_passkey_auth_transactions) THEN
    RAISE EXCEPTION 'PLATFORM_PASSKEY_STORAGE_REQUIRES_VERIFIED_RECOVERY' USING ERRCODE = '55000';
  END IF;
END;
$$;
DROP TABLE platform_passkey_auth_transactions;
DROP TABLE platform_passkey_credentials;
DROP FUNCTION protect_platform_passkey_credential();
